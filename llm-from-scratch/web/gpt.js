/*
 * Browser-side inference for the from-scratch GPT.
 *
 * This is a JavaScript port of the forward pass in ../model.py and the
 * tokenizers in ../tokenizer.py. It loads a model exported by ../export_web.py
 * and generates text entirely client-side -- no Python, no server compute.
 *
 * It runs both model generations:
 *   v1 (GPT-2 style): learned positions, LayerNorm, GELU MLP, biases, own head
 *   v2 (Llama style): rotary positions, RMSNorm, SwiGLU MLP, no biases, tied head
 * picking the path from the model's config (missing fields mean v1), and it
 * decodes f4 / f2 / q8 weights.
 *
 * Generation keeps a KV cache: each new token costs one pass over the weights
 * plus attention over the cached keys, instead of recomputing the whole
 * context every token (which is what made the first version ~1 token/s).
 * Weight matrices are transposed once at load so every dot product reads
 * memory sequentially. When the context window fills up, the cache is rebuilt
 * over the most recent 3/4 of it (positions restart at 0, exactly like a
 * fresh forward pass over those tokens), so a long generation stays fast and
 * the model only ever sees windows it was trained on.
 *
 * Works both as a <script src="gpt.js"> in the browser (attaches GPTLib to the
 * global object) and inside a Node vm sandbox / CommonJS (for the tests).
 */
(function (root) {
  "use strict";

  // --- base64 -> typed arrays ----------------------------------------------
  function b64ToBytes(b64) {
    const bin = (typeof atob === "function")
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);   // fresh buffer: aligned at offset 0
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function halfToFloat(h) {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x03ff;
    if (e === 0) return s * m * 5.960464477539063e-8;        // subnormal: m * 2^-24
    if (e === 31) return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * Math.pow(2, e - 15);
  }
  // Decode one exported tensor {shape, data, dtype?, axis?, scale?} to a
  // Float32Array. f4 = float32, f2 = float16, q8 = int8 with one float32 scale
  // per column (axis "col", the default: value = q * scale[j]) or per row
  // (axis "row", used for the embedding tables: value = q * scale[row]).
  // `defaultDtype` is the file-level dtype older exports used for every tensor.
  function decodeTensor(entry, defaultDtype) {
    const dtype = entry.dtype || defaultDtype || "f4";
    const bytes = b64ToBytes(entry.data);
    if (dtype === "q8") {
      const q = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const sb = b64ToBytes(entry.scale);
      const scale = new Float32Array(sb.buffer, sb.byteOffset, sb.byteLength / 4);
      const out = new Float32Array(q.length);
      if (entry.axis === "row") {
        const per = q.length / entry.shape[0];
        for (let i = 0, r = 0, c = 0; i < q.length; i++) { out[i] = q[i] * scale[r]; if (++c === per) { c = 0; r++; } }
      } else {
        const n = entry.shape[entry.shape.length - 1];
        for (let i = 0, j = 0; i < q.length; i++) { out[i] = q[i] * scale[j]; if (++j === n) j = 0; }
      }
      return out;
    }
    if (dtype === "f2") {
      const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const out = new Float32Array(u16.length);
      for (let i = 0; i < u16.length; i++) out[i] = halfToFloat(u16[i]);
      return out;
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  function b64ToFloat32(b64, dtype) { return decodeTensor({ data: b64 }, dtype); }

  // (rows, cols) row-major -> (cols, rows): dot products then read W sequentially.
  function transpose(W, rows, cols) {
    const T = new Float32Array(W.length);
    for (let r = 0; r < rows; r++) {
      const ro = r * cols;
      for (let c = 0; c < cols; c++) T[c * rows + r] = W[ro + c];
    }
    return T;
  }

  // --- kernels (one token at a time) ----------------------------------------
  // y[o] = b[o] + sum_i x[i] * Wt[o*inDim + i]
  function gemv(x, inDim, Wt, b, outDim, y) {
    const n4 = inDim & ~3;
    for (let o = 0; o < outDim; o++) {
      const off = o * inDim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, i = 0;
      for (; i < n4; i += 4) {
        s0 += x[i] * Wt[off + i];
        s1 += x[i + 1] * Wt[off + i + 1];
        s2 += x[i + 2] * Wt[off + i + 2];
        s3 += x[i + 3] * Wt[off + i + 3];
      }
      let s = (s0 + s1) + (s2 + s3);
      for (; i < inDim; i++) s += x[i] * Wt[off + i];
      y[o] = b ? s + b[o] : s;
    }
    return y;
  }
  function layernormInto(x, C, gamma, beta, y) {
    let mean = 0;
    for (let c = 0; c < C; c++) mean += x[c];
    mean /= C;
    let varr = 0;
    for (let c = 0; c < C; c++) { const d = x[c] - mean; varr += d * d; }
    varr /= C;
    const inv = 1 / Math.sqrt(varr + 1e-5);
    for (let c = 0; c < C; c++) y[c] = (x[c] - mean) * inv * gamma[c] + beta[c];
    return y;
  }
  function rmsnormInto(x, C, gamma, y) {
    let ms = 0;
    for (let c = 0; c < C; c++) ms += x[c] * x[c];
    const inv = 1 / Math.sqrt(ms / C + 1e-5);
    for (let c = 0; c < C; c++) y[c] = x[c] * inv * gamma[c];
    return y;
  }
  const GELU_C = Math.sqrt(2 / Math.PI);
  function geluInPlace(h, n) {
    for (let i = 0; i < n; i++) {
      const v = h[i];
      h[i] = 0.5 * v * (1 + Math.tanh(GELU_C * (v + 0.044715 * v * v * v)));
    }
  }
  // h = silu(g) * u
  function swigluInto(g, u, n, h) {
    for (let i = 0; i < n; i++) { const v = g[i]; h[i] = (v / (1 + Math.exp(-v))) * u[i]; }
  }
  // Rotary positions, "rotate-half" layout, same formula as autograd.rope_tables:
  // pairs (j, j+D/2), angle = pos * theta^(-2j/D). Tables are built in double
  // precision and rounded to float32 exactly like the NumPy side.
  function ropeInPlace(v, off, D, cosRow, sinRow) {
    const half = D >> 1;
    for (let j = 0; j < half; j++) {
      const c = cosRow[j], s = sinRow[j];
      const x1 = v[off + j], x2 = v[off + j + half];
      v[off + j] = x1 * c - x2 * s;
      v[off + j + half] = x2 * c + x1 * s;
    }
  }

  // --- the model -------------------------------------------------------------
  function Model(spec) {
    const cfg = spec.config;
    this.config = cfg;
    this.meta = spec.meta || null;
    this.format = spec.format || 1;
    this.tokenizer = makeTokenizer(spec.tokenizer);
    // Architecture switches (absent = the original v1 model).
    this.posEmb = cfg.pos_emb || "learned";
    this.normKind = cfg.norm || "layernorm";
    this.mlpKind = cfg.mlp || "gelu";
    this.tied = !!cfg.tie_embeddings;
    this.ropeTheta = cfg.rope_theta || 10000;

    const C = cfg.n_embd, V = cfg.vocab_size, L = cfg.n_layer;
    const w = {};
    for (const name in spec.weights) w[name] = decodeTensor(spec.weights[name], spec.dtype);
    const shape = (name) => spec.weights[name].shape;
    // Transpose every matrix used as x @ W to (out, in). wte stays (V, C): it is
    // a row lookup, and as a tied head logits[v] = x . wte[v] already reads rows.
    const Wt = (name) => transpose(w[name], shape(name)[0], shape(name)[1]);
    const layers = [];
    for (let l = 0; l < L; l++) {
      const p = "blocks." + l + ".";
      const lay = {
        ln1g: w[p + "ln1.gamma"], ln1b: w[p + "ln1.beta"] || null,
        ln2g: w[p + "ln2.gamma"], ln2b: w[p + "ln2.beta"] || null,
        qkvT: Wt(p + "attn.qkv.weight"), qkvB: w[p + "attn.qkv.bias"] || null,
        projT: Wt(p + "attn.proj.weight"), projB: w[p + "attn.proj.bias"] || null,
      };
      if (this.mlpKind === "swiglu") {
        lay.hidden = shape(p + "mlp.gate.weight")[1];
        lay.gateT = Wt(p + "mlp.gate.weight"); lay.gateB = w[p + "mlp.gate.bias"] || null;
        lay.upT = Wt(p + "mlp.up.weight"); lay.upB = w[p + "mlp.up.bias"] || null;
        lay.downT = Wt(p + "mlp.down.weight"); lay.downB = w[p + "mlp.down.bias"] || null;
      } else {
        lay.hidden = shape(p + "mlp.fc.weight")[1];
        lay.fcT = Wt(p + "mlp.fc.weight"); lay.fcB = w[p + "mlp.fc.bias"] || null;
        lay.proj2T = Wt(p + "mlp.proj.weight"); lay.proj2B = w[p + "mlp.proj.bias"] || null;
      }
      layers.push(lay);
    }
    this.layers = layers;
    this.wte = w["wte.weight"];
    this.wpe = w["wpe.weight"] || null;
    this.lnfg = w["ln_f.gamma"]; this.lnfb = w["ln_f.beta"] || null;
    this.headT = this.tied ? null : Wt("head.weight");
    this.w = w;   // raw decoded weights (kept for inspection / tests)

    const H = cfg.n_head, D = C / H;
    this.headDim = D;
    this.scale = 1 / Math.sqrt(D);
    const B = cfg.block_size;
    if (this.posEmb === "rope") {
      // cos/sin for every (position, pair) — the same numbers as
      // autograd.rope_tables: double-precision angles, rounded to float32.
      const half = D >> 1;
      this.ropeCos = new Float32Array(B * half); this.ropeSin = new Float32Array(B * half);
      for (let j = 0; j < half; j++) {
        const invFreq = Math.pow(this.ropeTheta, -(2 * j) / D);
        for (let t = 0; t < B; t++) {
          const ang = t * invFreq;
          this.ropeCos[t * half + j] = Math.cos(ang); this.ropeSin[t * half + j] = Math.sin(ang);
        }
      }
    }
    // When the window is full, continue with this many tokens (the newest
    // ones) — one amortised re-pass per block_size/4 generated tokens.
    this.keepOnOverflow = B - Math.max(1, Math.floor(B / 4));
    const hidden = layers.reduce((m, l) => Math.max(m, l.hidden), 0);
    // scratch buffers, allocated once
    this.buf = {
      x: new Float32Array(C), h: new Float32Array(C), qkv: new Float32Array(3 * C),
      att: new Float32Array(C), tmp: new Float32Array(C),
      m1: new Float32Array(hidden), m2: new Float32Array(hidden),
      scores: new Float32Array(B), logits: new Float32Array(V),
    };
    // KV cache: per layer, block_size rows of C (all heads side by side).
    this.cache = {
      k: layers.map(() => new Float32Array(B * C)),
      v: layers.map(() => new Float32Array(B * C)),
      len: 0,        // rows in use == position of the next token
      history: [],   // every id fed since reset(), for logitsForLast's prefix check
    };
    this.lastLogits = null;
  }

  Model.prototype.reset = function () {
    this.cache.len = 0; this.cache.history.length = 0;
    this.lastLogits = null;
  };

  // Feed one token; returns the logits for the token after it. The returned
  // Float32Array is reused by the next call — copy it if you keep it.
  Model.prototype.stepToken = function (id) {
    const cache = this.cache;
    if (cache.len === this.config.block_size) {
      // Window full: re-run the most recent tokens from position 0 so that,
      // with the new one appended, exactly `keepOnOverflow` tokens are in
      // play — GPT.crop_window() in model.py, the policy generate() follows,
      // so Python and the browser see the same context at every step.
      const keep = cache.history.slice(-(this.keepOnOverflow - 1));
      cache.len = 0;
      for (let i = 0; i < keep.length; i++) this._forward(keep[i]);
    }
    cache.history.push(id);
    return this._forward(id);
  };

  // One transformer pass for `id` at position cache.len (no bookkeeping).
  Model.prototype._forward = function (id) {
    const cfg = this.config, C = cfg.n_embd, V = cfg.vocab_size;
    const H = cfg.n_head, D = this.headDim, cache = this.cache, buf = this.buf;
    const pos = cache.len, t = cache.len;
    const x = buf.x, h = buf.h, qkv = buf.qkv, att = buf.att, tmp = buf.tmp;
    // token (+ learned position) embedding
    const to = id * C;
    if (this.wpe) { const po = pos * C; for (let c = 0; c < C; c++) x[c] = this.wte[to + c] + this.wpe[po + c]; }
    else for (let c = 0; c < C; c++) x[c] = this.wte[to + c];

    let cosRow = null, sinRow = null;
    if (this.posEmb === "rope") {
      const half = D >> 1;
      cosRow = this.ropeCos.subarray(pos * half, (pos + 1) * half);
      sinRow = this.ropeSin.subarray(pos * half, (pos + 1) * half);
    }

    for (let l = 0; l < this.layers.length; l++) {
      const lay = this.layers[l], K = cache.k[l], Vc = cache.v[l];
      // --- attention ---
      if (this.normKind === "rmsnorm") rmsnormInto(x, C, lay.ln1g, h); else layernormInto(x, C, lay.ln1g, lay.ln1b, h);
      gemv(h, C, lay.qkvT, lay.qkvB, 3 * C, qkv);
      if (cosRow) {
        for (let hd = 0; hd < H; hd++) { ropeInPlace(qkv, hd * D, D, cosRow, sinRow); ropeInPlace(qkv, C + hd * D, D, cosRow, sinRow); }
      }
      // write k, v for this position into the cache
      const row = t * C;
      for (let c = 0; c < C; c++) { K[row + c] = qkv[C + c]; Vc[row + c] = qkv[2 * C + c]; }
      const scores = buf.scores, n = t + 1, scale = this.scale;
      for (let hd = 0; hd < H; hd++) {
        const qo = hd * D, base = hd * D;
        let maxv = -Infinity;
        for (let s = 0; s < n; s++) {
          const ko = s * C + base;
          let dot = 0;
          for (let d = 0; d < D; d++) dot += qkv[qo + d] * K[ko + d];
          dot *= scale; scores[s] = dot; if (dot > maxv) maxv = dot;
        }
        let sum = 0;
        for (let s = 0; s < n; s++) { const e = Math.exp(scores[s] - maxv); scores[s] = e; sum += e; }
        const inv = 1 / sum;
        for (let d = 0; d < D; d++) att[base + d] = 0;
        for (let s = 0; s < n; s++) {
          const wgt = scores[s] * inv, vo = s * C + base;
          for (let d = 0; d < D; d++) att[base + d] += wgt * Vc[vo + d];
        }
      }
      gemv(att, C, lay.projT, lay.projB, C, tmp);
      for (let c = 0; c < C; c++) x[c] += tmp[c];
      // --- MLP ---
      if (this.normKind === "rmsnorm") rmsnormInto(x, C, lay.ln2g, h); else layernormInto(x, C, lay.ln2g, lay.ln2b, h);
      const hid = lay.hidden;
      if (this.mlpKind === "swiglu") {
        gemv(h, C, lay.gateT, lay.gateB, hid, buf.m1);
        gemv(h, C, lay.upT, lay.upB, hid, buf.m2);
        swigluInto(buf.m1, buf.m2, hid, buf.m1);
        gemv(buf.m1, hid, lay.downT, lay.downB, C, tmp);
      } else {
        gemv(h, C, lay.fcT, lay.fcB, hid, buf.m1);
        geluInPlace(buf.m1, hid);
        gemv(buf.m1, hid, lay.proj2T, lay.proj2B, C, tmp);
      }
      for (let c = 0; c < C; c++) x[c] += tmp[c];
    }
    cache.len = t + 1;

    if (this.normKind === "rmsnorm") rmsnormInto(x, C, this.lnfg, h); else layernormInto(x, C, this.lnfg, this.lnfb, h);
    const logits = buf.logits;
    if (this.tied) gemv(h, C, this.wte, null, V, logits); else gemv(h, C, this.headT, null, V, logits);
    this.lastLogits = logits;
    return logits;
  };

  // Logits for the position after the last token of `ids`. If `ids` extends
  // what the cache already holds by one token, this is a single step; the
  // same ids again returns the last logits; anything else rebuilds from the
  // last block_size tokens — exactly model.py's generate() crop.
  Model.prototype.logitsForLast = function (ids) {
    const hist = this.cache.history, n = ids.length, m = hist.length;
    if (m > 0 && (n === m || n === m + 1)) {
      let same = true;
      for (let i = 0; i < m; i++) if (ids[i] !== hist[i]) { same = false; break; }
      if (same) {
        if (n === m) return this.lastLogits;
        return this.stepToken(ids[n - 1]);
      }
    }
    this.reset();
    const start = Math.max(0, n - this.config.block_size);
    let lg = null;
    for (let i = start; i < n; i++) lg = this._forward(ids[i]);
    // remember ALL of `ids` (not just the window we ran) so the next call,
    // with one more token, is a single step even when the prompt was long
    for (let i = 0; i < n; i++) hist.push(ids[i]);
    this.lastLogits = lg;
    return lg;
  };

  // Sample `nTokens` continuation token ids from a prompt string.
  // opts: { temperature, topK, topP, repetitionPenalty, repetitionWindow, rng }
  Model.prototype.generate = function (prompt, nTokens, opts, onToken) {
    opts = opts || {};
    let ids = this.tokenizer.encode(prompt);
    if (ids.length === 0) ids = [this.tokenizer.stoi["\n"] || 0];
    const startLen = ids.length;
    this.reset();
    let logits = null;
    const start = Math.max(0, ids.length - this.config.block_size);
    for (let i = start; i < ids.length; i++) logits = this.stepToken(ids[i]);
    for (let n = 0; n < nTokens; n++) {
      const ctx = opts.repetitionWindow ? ids.slice(-opts.repetitionWindow) : ids;
      const next = sample(logits, opts, ctx);
      ids.push(next);
      if (onToken) onToken(this.tokenizer.decode([next]));
      logits = this.stepToken(next);
    }
    return this.tokenizer.decode(ids.slice(startLen));
  };

  // Nucleus (top-p) + top-k sampling with a repetition penalty. The repetition
  // penalty is what keeps a small model from collapsing into loops: tokens
  // already in the context get their logit divided (if positive) or multiplied
  // (if negative) by `repetitionPenalty`, so re-picking them is discouraged.
  // opts: { temperature, topK, topP, repetitionPenalty, rng }. ctx = ids so far.
  function sample(logits, opts, ctx) {
    opts = opts || {};
    const temperature = Math.max(opts.temperature == null ? 0.8 : opts.temperature, 1e-6);
    const topK = opts.topK == null ? 0 : opts.topK;              // 0 = disabled
    const topP = opts.topP == null ? 1 : opts.topP;              // 1 = disabled
    const rp = opts.repetitionPenalty == null ? 1 : opts.repetitionPenalty;
    const rng = opts.rng || Math.random;
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
    let r = rng() * s2;
    for (let j = 0; j < cutoff; j++) { r -= probs[j]; if (r <= 0) return order[j]; }
    return order[cutoff - 1];
  }

  // --- tokenizers (ports of ../tokenizer.py) ---------------------------------
  const SPLIT_RE = /\s+|\S+/g;

  function makeTokenizer(t) {
    return t.type === "bpe" ? new BPETok(t) : new CharTok(t);
  }

  // Lookup tables are prototype-less objects: with a plain {} the words
  // "constructor", "toString" or "__proto__" would hit Object.prototype.
  const dict = () => Object.create(null);

  function CharTok(t) {
    this.type = "char";
    this.chars = t.chars;
    this.stoi = dict(); this.itos = dict();
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

  // Merge ranks are keyed by the pair joined with NUL — a character no token can
  // contain. Joining with a space (the old key) made the whitespace-run pairs
  // ("  "," ") and (" ","  ") collide.
  const SEP = "\u0000";
  function BPETok(t) {
    this.type = "bpe";
    this.vocab = t.vocab;
    this.stoi = dict(); this.itos = dict();
    for (let i = 0; i < t.vocab.length; i++) { this.stoi[t.vocab[i]] = i; this.itos[i] = t.vocab[i]; }
    this.rank = dict();
    for (let i = 0; i < t.merges.length; i++) this.rank[t.merges[i][0] + SEP + t.merges[i][1]] = i;
    this.cache = dict();
  }
  BPETok.prototype._encodeChunk = function (chunk) {
    if (chunk in this.cache) return this.cache[chunk];
    let syms = Array.from(chunk);
    while (syms.length >= 2) {
      let bestRank = Infinity, bi = -1;
      for (let i = 0; i < syms.length - 1; i++) {
        const r = this.rank[syms[i] + SEP + syms[i + 1]];
        if (r !== undefined && r < bestRank) { bestRank = r; bi = i; }
      }
      if (bi < 0) break;
      // merge EVERY adjacent occurrence of the best pair (as tokenizer.py's _merge_syms does)
      const a = syms[bi], b = syms[bi + 1], out = [];
      for (let i = 0; i < syms.length;) {
        if (i < syms.length - 1 && syms[i] === a && syms[i + 1] === b) { out.push(a + b); i += 2; }
        else { out.push(syms[i]); i += 1; }
      }
      syms = out;
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

  const GPTLib = {
    version: 2,
    FORMAT: 2,   // the newest model.json "format" this engine can read
    Model: Model, makeTokenizer: makeTokenizer, sample: sample,
    b64ToFloat32: b64ToFloat32, decodeTensor: decodeTensor,
  };
  root.GPTLib = GPTLib;
  if (typeof module !== "undefined" && module.exports) module.exports = GPTLib;
})(typeof globalThis !== "undefined" ? globalThis : this);
