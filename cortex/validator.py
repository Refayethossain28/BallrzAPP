#!/usr/bin/env python3
"""Cortex independent chain validator — a SECOND IMPLEMENTATION, in Python.

Re-validates a Cortex Proof-of-Learning chain snapshot from scratch, sharing
zero code with the JavaScript engine (cortex/engine.js):

  * SHA-256 / double-SHA-256 (hashlib) and base58check addresses
  * secp256k1 ECDSA verification in pure Python integers
  * the deterministic transcendentals (detExp/detLn/detTanh/detSigmoid) —
    ports of the JS fork-safety layer, exact because IEEE-754 + - * / are
    correctly rounded in both runtimes
  * the MLP forward pass and binary cross-entropy loss, in the same
    accumulation order as the JS engine (float addition is order-sensitive)
  * genesis weights (mulberry32 + Irwin-Hall, recomputed from the seed)
  * every consensus rule: hash links, weights hash, recomputed loss, minimum
    improvement, the 10-year emission schedule, coinbase payout, transfer
    signatures, replay protection, and the MIND ledger

Two independent implementations agreeing on every block is the point: a bug
in one engine's consensus code can no longer silently become "the rules".

Usage:
    python3 cortex/validator.py <snapshot.json> [--genesis-seed SEED]
                                [--task-json '{"id": ..., ...}']

The snapshot is the JSON written by cortex/node.mjs ({taskId, blocks}) or the
browser's localStorage chain. Default task: the live warnet-v4 mainnet.
Exit code 0 = every block valid; 1 = invalid (reason printed).
"""
import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path

# ── JS-number semantics ──────────────────────────────────────────────────────

def js_round(x: float) -> float:
    """ECMAScript Math.round: nearest integer, ties toward +Infinity."""
    if x != x or x in (float("inf"), float("-inf")):
        return x
    r = math.floor(x + 0.5)
    # floor(x+0.5) overshoots when x+0.5 rounds up in float (spec says no)
    if r - x > 0.5:
        r -= 1
    return float(r)


def fmt9(x: float) -> str:
    """JS Number.prototype.toFixed(9) for the value ranges Cortex uses."""
    if x == 0:
        x = 0.0  # JS toFixed never prints a sign for -0
    return f"{x:.9f}"


def round9(x: float) -> float:
    return js_round(x * 1e9) / 1e9


# ── hashing & base58check ────────────────────────────────────────────────────

def sha256(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def sha256d(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(hashlib.sha256(data).digest()).hexdigest()


B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ADDRESS_VERSION = 0x19
MULTISIG_VERSION = 0x32


def base58_encode(b: bytes) -> str:
    n = int.from_bytes(b, "big") if b else 0
    s = ""
    while n > 0:
        n, r = divmod(n, 58)
        s = B58[r] + s
    for byte in b:
        if byte == 0:
            s = "1" + s
        else:
            break
    return s


def base58_decode(s: str) -> bytes:
    n = 0
    for ch in s:
        v = B58.find(ch)
        if v < 0:
            raise ValueError("bad base58 character")
        n = n * 58 + v
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    zeros = 0
    for ch in s:
        if ch == "1":
            zeros += 1
        else:
            break
    return b"\x00" * zeros + body


def address_from_pubkey(pub_hex: str) -> str:
    h160 = hashlib.sha256(hashlib.sha256(bytes.fromhex(pub_hex)).digest()).digest()[:20]
    data = bytes([ADDRESS_VERSION]) + h160
    checksum = hashlib.sha256(hashlib.sha256(data).digest()).digest()[:4]
    return base58_encode(data + checksum)


def is_valid_address(addr) -> bool:
    try:
        raw = base58_decode(addr)
        if len(raw) < 5:
            return False
        data, checksum = raw[:-4], raw[-4:]
        if hashlib.sha256(hashlib.sha256(data).digest()).digest()[:4] != checksum:
            return False
        return data[0] in (ADDRESS_VERSION, MULTISIG_VERSION) and len(data) == 21
    except Exception:
        return False


# ── secp256k1 ECDSA verification (pure integers) ────────────────────────────

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = (3 * x1 * x1) * pow(2 * y1, P - 2, P) % P
    else:
        lam = (y2 - y1) * pow((x2 - x1) % P, P - 2, P) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def _point_mul(k, pt):
    acc = None
    while k:
        if k & 1:
            acc = _point_add(acc, pt)
        pt = _point_add(pt, pt)
        k >>= 1
    return acc


def _decompress(pub_hex: str):
    if len(pub_hex) != 66 or pub_hex[:2] not in ("02", "03"):
        raise ValueError("bad public key")
    x = int(pub_hex[2:], 16)
    if x >= P:
        raise ValueError("pubkey x out of range")
    y2 = (x * x * x + 7) % P
    y = pow(y2, (P + 1) // 4, P)
    if y * y % P != y2:
        raise ValueError("point not on curve")
    if (y & 1) != (1 if pub_hex[:2] == "03" else 0):
        y = P - y
    return (x, y)


def ecdsa_verify(msg_hash_hex: str, sig_hex: str, pub_hex: str) -> bool:
    try:
        if not isinstance(sig_hex, str) or len(sig_hex) != 128:
            return False
        r, s = int(sig_hex[:64], 16), int(sig_hex[64:], 16)
        if not (0 < r < N and 0 < s < N):
            return False
        q = _decompress(pub_hex)
        e = int(msg_hash_hex, 16) % N
        w = pow(s, N - 2, N)
        u1, u2 = e * w % N, r * w % N
        pt = _point_add(_point_mul(u1, G), _point_mul(u2, q))
        if pt is None:
            return False
        return pt[0] % N == r
    except Exception:
        return False


# ── deterministic transcendentals (ports of the JS fork-safety layer) ───────

LN2 = 0.6931471805599453


def _pow2(k: int) -> float:
    r, b, nn = 1.0, (0.5 if k < 0 else 2.0), abs(k)
    for _ in range(nn):
        r *= b
    return r


def dexp(x: float) -> float:
    if x > 709:
        x = 709
    if x < -745:
        x = -745
    k = int(js_round(x / LN2))
    r = x - k * LN2
    t, s = 1.0, 1.0
    for i in range(1, 10):
        t *= r / i
        s += t
    return s * _pow2(k)


def dln(x: float) -> float:
    if x <= 0:
        return float("-inf")
    e, m = 0, x
    while m >= 2:
        m *= 0.5
        e += 1
    while m < 1:
        m *= 2
        e -= 1
    u = (m - 1) / (m + 1)
    u2 = u * u
    term, total = u, 0.0
    for i in range(1, 22, 2):
        total += term / i
        term *= u2
    return e * LN2 + 2 * total


def dtanh(x: float) -> float:
    ax = -x if x < 0 else x
    if ax > 20:
        return -1.0 if x < 0 else 1.0
    e = dexp(-2 * ax)
    r = (1 - e) / (1 + e)
    return -r if x < 0 else r


def dsigmoid(x: float) -> float:
    if x >= 0:
        return 1 / (1 + dexp(-x))
    e = dexp(x)
    return e / (1 + e)


# ── deterministic randomness (mulberry32 + Irwin-Hall) ──────────────────────

def _u32(x: int) -> int:
    return x & 0xFFFFFFFF


def _i32(x: int) -> int:
    x = _u32(x)
    return x - 0x100000000 if x >= 0x80000000 else x


def _imul(a: int, b: int) -> int:
    return _i32(_u32(a) * _u32(b))


def seed_from(s: str) -> int:
    return int(sha256(s)[:8], 16) or 1


def mulberry32(seed: int):
    state = _u32(seed)

    def rng() -> float:
        nonlocal state
        state = _u32(state + 0x6D2B79F5)
        s_i = _i32(state)
        t = _imul(s_i ^ (_u32(s_i) >> 15), 1 | s_i)
        t = _i32((t + _imul(t ^ (_u32(t) >> 7), 61 | t)) ^ t)
        return _u32(t ^ (_u32(t) >> 14)) / 4294967296

    return rng


def gaussian(rng) -> float:
    return sum(rng() for _ in range(12)) - 6


def quantise(w, q):
    return [js_round(x / q) * q for x in w]


# ── the task: dataset, standardisation, architecture ────────────────────────

def arch_of(inputs, layers):
    return [inputs] + list(layers) + [1]


def dim_of(arch):
    return sum(arch[i] * arch[i + 1] + arch[i + 1] for i in range(len(arch) - 1))


def load_embedded_csv(name: str):
    """Extract an embedded dataset verbatim from cortex/datasets.js."""
    src = (Path(__file__).parent / "datasets.js").read_text()
    m = re.search(r"var %s_CSV = `\n?(.*?)`;" % name.upper(), src, re.S)
    if not m:
        raise SystemExit(f"dataset {name} not found in datasets.js")
    rows = [
        [float(v) for v in line.split(",")]
        for line in m.group(1).strip().splitlines()
        if line.strip()
    ]
    return [r[:-1] for r in rows], [int(r[-1]) for r in rows]


def standardise(features):
    n, dim = len(features), len(features[0])
    mean = [0.0] * dim
    for i in range(n):          # same accumulation order as the JS engine
        for d in range(dim):
            mean[d] += features[i][d]
    for d in range(dim):
        mean[d] /= n
    std = [0.0] * dim
    for i in range(n):
        for d in range(dim):
            e = features[i][d] - mean[d]
            std[d] += e * e
    for d in range(dim):
        std[d] = math.sqrt(std[d] / n) or 1
    return [[(features[i][d] - mean[d]) / std[d] for d in range(dim)] for i in range(n)]


def make_task(opts):
    t = dict(opts)
    t.setdefault("quantum", 1e-6)
    t.setdefault("minImprovement", 0.004)
    t.setdefault("rewardPerLoss", 1000000)
    if "dataset" in t:
        feats, labels = load_embedded_csv(t["dataset"])
        t["X"] = standardise(feats)
        t["y"] = labels
        t["inputs"] = len(feats[0])
    else:
        raise SystemExit("this validator supports embedded-dataset tasks (the live network)")
    t["arch"] = arch_of(t["inputs"], t["layers"])
    t["dim"] = dim_of(t["arch"])
    return t


def random_weights(task, seed_str: str):
    rng = mulberry32(seed_from(f"init:{task['id']}:{seed_str or ''}"))
    arch, w = task["arch"], []
    for li in range(len(arch) - 1):
        in_n, out_n = arch[li], arch[li + 1]
        scale = 1 / math.sqrt(in_n)
        for _ in range(out_n * in_n):
            w.append(gaussian(rng) * scale)
        w.extend([0.0] * out_n)
    return quantise(w, task["quantum"])


# ── the model: forward pass + loss, in JS accumulation order ────────────────

def unpack(task, w):
    arch, k, layers = task["arch"], 0, []
    for li in range(len(arch) - 1):
        in_n, out_n = arch[li], arch[li + 1]
        W = []
        for _ in range(out_n):
            W.append(w[k:k + in_n])
            k += in_n
        b = w[k:k + out_n]
        k += out_n
        layers.append((W, b, in_n, out_n, li == len(arch) - 2))
    return layers


def forward_p(layers, x):
    a = x
    for W, b, in_n, out_n, is_out in layers:
        out = []
        for o in range(out_n):
            s = b[o]
            row = W[o]
            for i in range(in_n):
                s += row[i] * a[i]
            out.append(dsigmoid(s) if is_out else dtanh(s))
        a = out
    return a[0]


def loss_of(task, w):
    layers = unpack(task, w)
    total = 0.0
    for x, y in zip(task["X"], task["y"]):
        p = forward_p(layers, x)
        p = min(1 - 1e-12, max(1e-12, p))
        total += -(y * dln(p) + (1 - y) * dln(1 - p))
    return total / len(task["X"])


# ── blocks: canonical forms, hashes, transfers ───────────────────────────────

GENESIS_PREV = "0" * 64


def js_num(x):
    """String(number) for the integers Cortex puts in canonical forms."""
    if isinstance(x, float) and x.is_integer() and abs(x) < 2**53:
        return str(int(x))
    return str(x)


def weights_hash(task, w):
    q = task["quantum"]
    return sha256(",".join(fmt9(js_round(x / q) * q) for x in w))


def canonical(b):
    return "|".join([
        js_num(b["index"]), b["prevHash"], b["taskId"], b["weightsHash"],
        fmt9(b["loss"]), js_num(b["reward"]), b["txsRoot"], b["miner"],
        b["pubKey"], js_num(b["at"]), str(b["nonce"]),
    ])


def block_hash(b):
    return sha256d(canonical(b))


def tx_canonical(tx):
    return "|".join([tx["from"], tx["to"], js_num(tx["amount"]), js_num(tx["at"]), str(tx["nonce"])])


def tx_id(tx):
    return sha256d(tx_canonical(tx) + "|" + tx["pubKey"] + "|" + tx["sig"])


def txs_root(txs):
    return sha256("|".join(t["id"] for t in (txs or [])))


def verify_transfer(tx) -> bool:
    if not isinstance(tx, dict):
        return False
    if not is_valid_address(tx.get("from")) or not is_valid_address(tx.get("to")) or tx["from"] == tx["to"]:
        return False
    if not isinstance(tx.get("amount"), int) or tx["amount"] <= 0:
        return False
    if not tx.get("pubKey") or address_from_pubkey(tx["pubKey"]) != tx["from"]:
        return False
    return ecdsa_verify(sha256(tx_canonical(tx)), tx.get("sig", ""), tx["pubKey"])


# ── the consensus rules ──────────────────────────────────────────────────────

def allowed_loss(task, baseline_loss, at_ms):
    s = task.get("schedule")
    if not s:
        return float("-inf")
    dt = at_ms - s["startAt"]
    if not dt > 0:
        return baseline_loss
    remaining = s["budget"] * dexp(-(dt / s["halfLifeMs"]) * LN2)
    return round9(baseline_loss - s["budget"] + remaining)


def block_reward(task, prev_loss, new_loss):
    return max(0, int(js_round((prev_loss - new_loss) * task["rewardPerLoss"])))


def validate_block(task, baseline_loss, block, prev):
    def bad(reason):
        return (False, f"block #{block.get('index', '?')}: {reason}")

    if block.get("taskId") != task["id"]:
        return bad("wrong task")
    if block.get("index") != prev["index"] + 1:
        return bad("index not sequential")
    if block.get("prevHash") != prev["hash"]:
        return bad("does not link to parent")
    w = block.get("weights")
    if not isinstance(w, list) or len(w) != task["dim"]:
        return bad("wrong weight shape")
    if block.get("weightsHash") != weights_hash(task, w):
        return bad("weights hash mismatch")
    if block.get("hash") != block_hash(block):
        return bad("block hash mismatch")
    actual = round9(loss_of(task, w))
    if abs(actual - block["loss"]) > 1e-9:
        return bad(f"claimed loss is false (recomputed {actual!r}, claimed {block['loss']!r})")
    if block["loss"] > prev["loss"] - task["minImprovement"] + 1e-12:
        return bad("insufficient learning")
    s = task.get("schedule")
    if s:
        prev_at = s["startAt"] if prev["index"] == 0 else prev["at"]
        if not block["at"] >= prev_at + s["minIntervalMs"]:
            return bad("too soon after previous block")
        if block["loss"] < allowed_loss(task, baseline_loss, block["at"]) - 1e-9:
            return bad("ahead of schedule")
    if block.get("reward") != block_reward(task, prev["loss"], block["loss"]):
        return bad("wrong block reward")
    txs = block.get("txs") or []
    if not isinstance(txs, list):
        return bad("bad transfer list")
    if block.get("txsRoot") != txs_root(txs):
        return bad("transfers root mismatch")
    seen = set()
    for tx in txs:
        if not verify_transfer(tx):
            return bad("invalid transfer")
        key = tx["from"] + "|" + str(tx["nonce"])
        if key in seen:
            return bad("duplicate transfer in block")
        seen.add(key)
    if not is_valid_address(block.get("miner")):
        return bad("bad miner address")
    try:
        if not ecdsa_verify(sha256(canonical(block)), block.get("sig", ""), block["pubKey"]):
            return bad("bad signature")
    except Exception:
        return bad("bad signature")
    return (True, "")


def validate_chain(task, blocks, genesis_seed):
    if not blocks:
        return (False, "empty chain", None)
    g = blocks[0]
    if g["index"] != 0 or g["prevHash"] != GENESIS_PREV or g["taskId"] != task["id"]:
        return (False, "bad genesis header", None)
    expect_w = random_weights(task, genesis_seed)
    if len(g["weights"]) != len(expect_w) or any(a != b for a, b in zip(g["weights"], expect_w)):
        return (False, "genesis weights do not match the seed", None)
    if g["weightsHash"] != weights_hash(task, g["weights"]) or g["hash"] != block_hash(g):
        return (False, "bad genesis hashes", None)
    if abs(round9(loss_of(task, g["weights"])) - g["loss"]) > 1e-9:
        return (False, "bad genesis loss", None)
    if g.get("reward") or (g.get("txs") and len(g["txs"])) or g["txsRoot"] != txs_root(g.get("txs") or []):
        return (False, "genesis mints nothing", None)

    balances, used = {}, set()
    for i in range(1, len(blocks)):
        ok, reason = validate_block(task, g["loss"], blocks[i], blocks[i - 1])
        if not ok:
            return (False, reason, None)
        b = blocks[i]
        balances[b["miner"]] = balances.get(b["miner"], 0) + b["reward"]
        for tx in b.get("txs") or []:
            key = tx["from"] + "|" + str(tx["nonce"])
            if key in used:
                return (False, f"block #{b['index']}: replayed transfer nonce", None)
            if balances.get(tx["from"], 0) < tx["amount"]:
                return (False, f"block #{b['index']}: overdraft", None)
            used.add(key)
            balances[tx["from"]] -= tx["amount"]
            balances[tx["to"]] = balances.get(tx["to"], 0) + tx["amount"]
    return (True, "", balances)


# ── CLI ──────────────────────────────────────────────────────────────────────

MAINNET_V4 = {
    "id": "cortex-warnet-v4",
    "dataset": "war",
    "layers": [24, 24],
    "minImprovement": 0.000002,
    "rewardPerLoss": 3000000000000,
    "schedule": {"startAt": 1783641600000, "halfLifeMs": 72582480000, "budget": 0.32, "minIntervalMs": 60000},
}


def main():
    ap = argparse.ArgumentParser(description="Independently validate a Cortex chain snapshot.")
    ap.add_argument("snapshot", help="chain snapshot JSON ({taskId, blocks})")
    ap.add_argument("--genesis-seed", default="cortex-genesis")
    ap.add_argument("--task-json", help="task options as JSON (default: live warnet-v4)")
    args = ap.parse_args()

    snap = json.loads(Path(args.snapshot).read_text())
    opts = json.loads(args.task_json) if args.task_json else MAINNET_V4
    if snap.get("taskId") and snap["taskId"] != opts["id"]:
        print(f"INVALID: snapshot is for task {snap['taskId']!r}, validating {opts['id']!r}")
        return 1
    task = make_task(opts)

    ok, reason, balances = validate_chain(task, snap["blocks"], args.genesis_seed)
    if not ok:
        print(f"INVALID: {reason}")
        return 1
    tip = snap["blocks"][-1]
    supply = sum(balances.values()) if balances else 0
    print(f"VALID: {len(snap['blocks']) - 1} block(s) on {task['id']}")
    print(f"  tip loss {tip['loss']:.9f} · total supply {supply} base units ({supply / 1e6:.6f} MIND)")
    for addr, bal in sorted((balances or {}).items(), key=lambda kv: -kv[1])[:10]:
        print(f"  {addr}  {bal / 1e6:.6f} MIND")
    return 0


if __name__ == "__main__":
    sys.exit(main())
