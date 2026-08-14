/*
 * Browser-side inference for the from-scratch GPT.
 *
 * This is a JavaScript port of the forward pass in ../model.py and the
 * tokenizers in ../tokenizer.py. It loads a model exported by ../export_web.py
 * and generates text entirely client-side -- no Python, no server compute.
 *
 * Works both as a <script src="gpt.js"> in the browser (attaches GPTLib to the
 * global object) and as a CommonJS module in Node (for the test harness).
 */
(function (root) {
  "use strict";

  // --- base64 -> Float32Array ------------------------------------------------
  // Weights are exported little-endian as float32 ("f4") or float16 ("f2" —
  // half the download; export_web.py --dtype f2). f16 is decoded manually so it
  // works everywhere (Float16Array is too new to rely on).
  function b64ToBytes(b64) {
    const bin = (typeof atob === "function")
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x03ff;
    if (e === 0) return s * m * 5.960464477539063e-8;        // subnormal: m * 2^-24
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * Math.pow(2, e - 15);
  }
  function b64ToFloat32(b64, dtype) {
    const bytes = b64ToBytes(b64);
    if (dtype === "f2") {
      const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const out = new Float32Array(u16.length);
      for (let i = 0; i < u16.length; i++) out[i] = halfToFloat(u16[i]);
      return out;
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  // --- primitive ops (plain loops over Float32Array) -------------------------
  // y = x @ W (+ b).  x: (T, inDim), W: (inDim, outDim) row-major, b: (outDim)
  function linear(x, T, inDim, W, b, outDim) {
    const y = new Float32Array(T * outDim);
    for (let t = 0; t < T; t++) {
      const xo = t * inDim, yo = t * outDim;
      for (let o = 0; o < outDim; o++) {
        let s = b ? b[o] : 0;
        for (let i = 0; i < inDim; i++) s += x[xo + i] * W[i * outDim + o];
        y[yo + o] = s;
      }
    }
    return y;
  }

  function layernorm(x, T, C, gamma, beta) {
    const y = new Float32Array(T * C), eps = 1e-5;
    for (let t = 0; t < T; t++) {
      const o = t * C;
      let mean = 0;
      for (let c = 0; c < C; c++) mean += x[o + c];
      mean /= C;
      let varr = 0;
      for (let c = 0; c < C; c++) { const d = x[o + c] - mean; varr += d * d; }
      varr /= C;
      const inv = 1 / Math.sqrt(varr + eps);
      for (let c = 0; c < C; c++) y[o + c] = (x[o + c] - mean) * inv * gamma[c] + beta[c];
    }
    return y;
  }

  function gelu(x) {
    const y = new Float32Array(x.length), c = Math.sqrt(2 / Math.PI);
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      y[i] = 0.5 * v * (1 + Math.tanh(c * (v + 0.044715 * v * v * v)));
    }
    return y;
  }

  // Causal multi-head self-attention. x: (T, C). Layout of qkv matches model.py:
  // the 3C output is [q(C) | k(C) | v(C)], each split into (nHead, headDim).
  function attention(x, T, C, nHead, headDim, qkvW, qkvB, projW, projB) {
    const qkv = linear(x, T, C, qkvW, qkvB, 3 * C);
    const out = new Float32Array(T * C);
    const scale = 1 / Math.sqrt(headDim);
    const scores = new Float32Array(T);
    for (let h = 0; h < nHead; h++) {
      const base = h * headDim;
      for (let t = 0; t < T; t++) {
        const qoff = t * 3 * C + 0 * C + base;
        // scores against all keys s <= t
        let maxv = -Infinity;
        for (let s = 0; s <= t; s++) {
          const koff = s * 3 * C + 1 * C + base;
          let dot = 0;
          for (let d = 0; d < headDim; d++) dot += qkv[qoff + d] * qkv[koff + d];
          dot *= scale;
          scores[s] = dot;
          if (dot > maxv) maxv = dot;
        }
        let sum = 0;
        for (let s = 0; s <= t; s++) { scores[s] = Math.exp(scores[s] - maxv); sum += scores[s]; }
        const outoff = t * C + base;
        for (let s = 0; s <= t; s++) {
          const w = scores[s] / sum;
          const voff = s * 3 * C + 2 * C + base;
          for (let d = 0; d < headDim; d++) out[outoff + d] += w * qkv[voff + d];
        }
      }
    }
    return linear(out, T, C, projW, projB, C);
  }

  function addInto(a, b) { for (let i = 0; i < a.length; i++) a[i] += b[i]; return a; }

  // --- the model -------------------------------------------------------------
  function Model(spec) {
    this.config = spec.config;
    this.tokenizer = makeTokenizer(spec.tokenizer);
    const w = {};
    const dtype = spec.dtype || "f4";
    for (const name in spec.weights) w[name] = b64ToFloat32(spec.weights[name].data, dtype);
    this.w = w;
  }

  // Returns logits (Float32Array length vocab_size) for the position after the
  // last token of `ids`.
  Model.prototype.logitsForLast = function (ids) {
    const cfg = this.config, C = cfg.n_embd, w = this.w;
    let T = ids.length;
    if (T > cfg.block_size) { ids = ids.slice(T - cfg.block_size); T = cfg.block_size; }

    // token + positional embeddings
    let x = new Float32Array(T * C);
    for (let t = 0; t < T; t++) {
      const tok = ids[t] * C, pos = t * C, o = t * C;
      for (let c = 0; c < C; c++) x[o + c] = w["wte.weight"][tok + c] + w["wpe.weight"][pos + c];
    }

    const nHead = cfg.n_head, headDim = C / nHead;
    for (let l = 0; l < cfg.n_layer; l++) {
      const p = "blocks." + l + ".";
      const a = attention(
        layernorm(x, T, C, w[p + "ln1.gamma"], w[p + "ln1.beta"]),
        T, C, nHead, headDim,
        w[p + "attn.qkv.weight"], w[p + "attn.qkv.bias"],
        w[p + "attn.proj.weight"], w[p + "attn.proj.bias"]);
      addInto(x, a);
      const h1 = layernorm(x, T, C, w[p + "ln2.gamma"], w[p + "ln2.beta"]);
      const h2 = gelu(linear(h1, T, C, w[p + "mlp.fc.weight"], w[p + "mlp.fc.bias"], 4 * C));
      const m = linear(h2, T, 4 * C, w[p + "mlp.proj.weight"], w[p + "mlp.proj.bias"], C);
      addInto(x, m);
    }

    x = layernorm(x, T, C, w["ln_f.gamma"], w["ln_f.beta"]);
    // only the last row matters for next-token prediction
    const last = x.subarray((T - 1) * C, T * C);
    return linear(last, 1, C, w["head.weight"], null, cfg.vocab_size);
  };

  // Sample `nTokens` continuation token ids from a prompt string.
  Model.prototype.generate = function (prompt, nTokens, opts, onToken) {
    opts = opts || {};
    let ids = this.tokenizer.encode(prompt);
    if (ids.length === 0) ids = [this.tokenizer.stoi["\n"] || 0];
    const startLen = ids.length;
    for (let n = 0; n < nTokens; n++) {
      const logits = this.logitsForLast(ids);
      const next = sample(logits, opts, ids);
      ids.push(next);
      if (onToken) onToken(this.tokenizer.decode([next]));
    }
    return this.tokenizer.decode(ids.slice(startLen));
  };

  // Nucleus (top-p) + top-k sampling with a repetition penalty. The repetition
  // penalty is what keeps a small model from collapsing into loops: tokens
  // already in the context get their logit divided (if positive) or multiplied
  // (if negative) by `repetitionPenalty`, so re-picking them is discouraged.
  // opts: { temperature, topK, topP, repetitionPenalty }. ctx = ids so far.
  function sample(logits, opts, ctx) {
    opts = opts || {};
    const temperature = Math.max(opts.temperature == null ? 0.8 : opts.temperature, 1e-6);
    const topK = opts.topK == null ? 0 : opts.topK;              // 0 = disabled
    const topP = opts.topP == null ? 1 : opts.topP;              // 1 = disabled
    const rp = opts.repetitionPenalty == null ? 1 : opts.repetitionPenalty;
    const n = logits.length;
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) z[i] = logits[i];

    if (rp !== 1 && ctx && ctx.length) {
      const seen = ctx instanceof Set ? ctx : new Set(ctx);
      seen.forEach((id) => { if (id >= 0 && id < n) z[id] = z[id] > 0 ? z[id] / rp : z[id] * rp; });
    }
    for (let i = 0; i < n; i++) z[i] /= temperature;

    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => z[b] - z[a]);
    const k = (topK && topK > 0) ? Math.min(topK, n) : n;

    // softmax over the top-k logits
    const maxv = z[order[0]];
    const probs = new Float64Array(k);
    let sum = 0;
    for (let j = 0; j < k; j++) { const p = Math.exp(z[order[j]] - maxv); probs[j] = p; sum += p; }
    for (let j = 0; j < k; j++) probs[j] /= sum;

    // top-p nucleus: shortest prefix whose cumulative prob reaches topP
    let cutoff = k;
    if (topP < 1) {
      let cum = 0;
      for (let j = 0; j < k; j++) { cum += probs[j]; if (cum >= topP) { cutoff = j + 1; break; } }
    }
    let s2 = 0; for (let j = 0; j < cutoff; j++) s2 += probs[j];
    let r = Math.random() * s2;
    for (let j = 0; j < cutoff; j++) { r -= probs[j]; if (r <= 0) return order[j]; }
    return order[cutoff - 1];
  }

  // --- tokenizers (ports of ../tokenizer.py) ---------------------------------
  const SPLIT_RE = /\s+|\S+/g;

  function makeTokenizer(t) {
    return t.type === "bpe" ? new BPETok(t) : new CharTok(t);
  }

  function CharTok(t) {
    this.chars = t.chars;
    this.stoi = {}; this.itos = {};
    for (let i = 0; i < t.chars.length; i++) { this.stoi[t.chars[i]] = i; this.itos[i] = t.chars[i]; }
  }
  CharTok.prototype.encode = function (text) {
    const ids = [];
    for (const ch of text) if (ch in this.stoi) ids.push(this.stoi[ch]);
    return ids;
  };
  CharTok.prototype.decode = function (ids) {
    let s = ""; for (const i of ids) if (i in this.itos) s += this.itos[i]; return s;
  };

  function BPETok(t) {
    this.vocab = t.vocab;
    this.stoi = {}; this.itos = {};
    for (let i = 0; i < t.vocab.length; i++) { this.stoi[t.vocab[i]] = i; this.itos[i] = t.vocab[i]; }
    this.rank = {};
    for (let i = 0; i < t.merges.length; i++) this.rank[t.merges[i][0] + " " + t.merges[i][1]] = i;
    this.cache = {};
  }
  BPETok.prototype._encodeChunk = function (chunk) {
    if (chunk in this.cache) return this.cache[chunk];
    let syms = Array.from(chunk);
    while (syms.length >= 2) {
      let best = -1, bestRank = Infinity, bi = -1;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = this.rank[syms[i] + " " + syms[i + 1]];
        if (r !== undefined && r < bestRank) { bestRank = r; bi = i; }
      }
      if (bi < 0) break;
      syms = syms.slice(0, bi).concat([syms[bi] + syms[bi + 1]], syms.slice(bi + 2));
    }
    const ids = [];
    for (const s of syms) if (s in this.stoi) ids.push(this.stoi[s]);
    this.cache[chunk] = ids;
    return ids;
  };
  BPETok.prototype.encode = function (text) {
    const ids = []; const m = text.match(SPLIT_RE) || [];
    for (const chunk of m) for (const id of this._encodeChunk(chunk)) ids.push(id);
    return ids;
  };
  BPETok.prototype.decode = function (ids) {
    let s = ""; for (const i of ids) if (i in this.itos) s += this.itos[i]; return s;
  };

  const GPTLib = { Model: Model, makeTokenizer: makeTokenizer, b64ToFloat32: b64ToFloat32 };
  root.GPTLib = GPTLib;
  if (typeof module !== "undefined" && module.exports) module.exports = GPTLib;
})(typeof globalThis !== "undefined" ? globalThis : this);
