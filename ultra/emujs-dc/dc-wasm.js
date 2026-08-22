/* dc-wasm.js — a from-scratch browser libretro frontend for the Flycast
 * (Sega Dreamcast) WebAssembly core.
 * =====================================================================
 * The romdev Flycast core ships an emscripten module but no browser player —
 * its only host drives the GPU through a Node-native GL stack. This module is
 * the missing browser frontend: it instantiates the core, implements the
 * libretro RETRO_ENVIRONMENT callback, negotiates SET_HW_RENDER, and binds the
 * core's GL to a real <canvas> so the PowerVR2 renders straight to the screen
 * (get_current_framebuffer → 0, no readback). reios HLE BIOS is enabled, so a
 * homebrew .elf or a disc image the user owns boots without Sega firmware.
 *
 * ES module on purpose — the Flycast glue is `export default create_flycast`.
 * Loaded only by dc.html; the smoke test skips modules.
 */

// ---- libretro environment command IDs (RETRO_ENVIRONMENT_*) ----
const EXPERIMENTAL = 0x10000;
const E = {
  GET_OVERSCAN: 2, GET_CAN_DUPE: 3, SET_MESSAGE: 6, SET_PERFORMANCE_LEVEL: 8,
  GET_SYSTEM_DIRECTORY: 9, SET_PIXEL_FORMAT: 10, SET_INPUT_DESCRIPTORS: 11,
  SET_HW_RENDER: 14, GET_VARIABLE: 15, SET_VARIABLES: 16, GET_VARIABLE_UPDATE: 17,
  SET_SUPPORT_NO_GAME: 18, GET_LOG_INTERFACE: 27, GET_SAVE_DIRECTORY: 31,
  GET_CONTENT_DIRECTORY: 30, GET_LIBRETRO_PATH: 19, SET_GEOMETRY: 37,
  GET_LANGUAGE: 39, SET_SYSTEM_AV_INFO: 32, GET_AUDIO_VIDEO_ENABLE: 47,
  GET_INPUT_BITMASKS: 51, GET_CORE_OPTIONS_VERSION: 52, SET_CORE_OPTIONS: 53,
  SET_CORE_OPTIONS_INTL: 54, SET_CORE_OPTIONS_DISPLAY: 55, GET_PREFERRED_HW_RENDER: 56,
  SET_CORE_OPTIONS_V2: 67, SET_CORE_OPTIONS_V2_INTL: 68,
};

// Flycast options we force so a homebrew binary boots with no real BIOS and
// presents through the direct-framebuffer scanout path.
const DC_OPTIONS = {
  flycast_hle_bios: 'enabled',
  flycast_boot_to_bios: 'disabled',
  flycast_emulate_framebuffer: 'enabled',
  flycast_threaded_rendering: 'disabled',
  flycast_internal_resolution: '640x480',
  flycast_region: 'Default',
  flycast_language: 'Default',
  flycast_cable_type: 'VGA (RGB)',
  flycast_enable_dsp: 'enabled',
};

// RetroPad button id → our input bit. Standard libretro JOYPAD ids.
const JOYPAD = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, A: 8, X: 9, L: 10, R: 11 };

export async function bootDreamcast(opts) {
  const { canvas, romBytes, romName, dataPath, onLog, onStatus } = opts;
  const log = onLog || (() => {});
  const status = onStatus || (() => {});

  // ---- 1. instantiate the emscripten core, GL bound to our canvas ----
  status('loading core…');
  const factoryUrl = (dataPath || './') + 'flycast_libretro.js';
  const { default: createFlycast } = await import(factoryUrl);
  const wasmUrl = (dataPath || './') + 'flycast_libretro.wasm';
  const wasmBinary = new Uint8Array(await (await fetch(wasmUrl)).arrayBuffer());

  const mod = await createFlycast({
    wasmBinary,
    canvas,
    print: (s) => log(String(s)),
    printErr: (s) => log(String(s)),
    locateFile: (p) => (dataPath || './') + p,
  });

  // Bind the core's GL to the visible canvas (emscripten GL API).
  const glCtx = mod.GL.createContext(canvas, {
    majorVersion: 2, minorVersion: 0, antialias: false, depth: true, stencil: true, alpha: false,
    preserveDrawingBuffer: false, failIfMajorPerformanceCaveat: false,
  });
  if (!glCtx) throw new Error('WebGL2 is required and could not be created on this device');
  mod.GL.makeContextCurrent(glCtx);

  // ---- 2. per-core callback state ----
  const state = {
    pixelFormat: 1,
    coreVariables: new Map(),
    variablesUpdated: true,
    hw: { contextResetPtr: 0, contextDestroyPtr: 0, bottomLeft: true, active: false },
    _logCbPtr: 0, _ptrs: [],
  };
  // pre-seed forced options
  for (const k in DC_OPTIONS) state.coreVariables.set(k, { value: DC_OPTIONS[k], options: [DC_OPTIONS[k]] });

  const allocStr = (s) => {
    const bytes = new TextEncoder().encode(s + '\0');
    const p = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, p);
    state._ptrs.push(p);
    return p;
  };

  // ---- 3. the environment callback ----
  function environ(rawCmd, dataPtr) {
    const cmd = rawCmd & ~EXPERIMENTAL;
    switch (cmd) {
      case E.GET_CAN_DUPE: mod.setValue(dataPtr, 1, 'i8'); return true;
      case E.GET_OVERSCAN: mod.setValue(dataPtr, 0, 'i8'); return true;
      case E.SET_MESSAGE: return true;
      case E.SET_PERFORMANCE_LEVEL: return true;
      case E.SET_SUPPORT_NO_GAME: return true;
      case E.GET_AUDIO_VIDEO_ENABLE: mod.setValue(dataPtr, 3, 'i32'); return true; // audio+video
      case E.GET_LANGUAGE: mod.setValue(dataPtr, 0, 'i32'); return true;
      case E.GET_INPUT_BITMASKS: return true;
      case E.GET_CORE_OPTIONS_VERSION: mod.setValue(dataPtr, 0, 'i32'); return true; // legacy SET_VARIABLES path

      case E.GET_SYSTEM_DIRECTORY:
      case E.GET_SAVE_DIRECTORY:
      case E.GET_CONTENT_DIRECTORY:
      case E.GET_LIBRETRO_PATH:
        mod.setValue(dataPtr, allocStr('/system'), 'i32'); return true;

      case E.SET_PIXEL_FORMAT: {
        const fmt = mod.getValue(dataPtr, 'i32');
        if (fmt === 0 || fmt === 1 || fmt === 2) { state.pixelFormat = fmt; return true; }
        return false;
      }

      case E.GET_LOG_INTERFACE: {
        if (!state._logCbPtr) {
          state._logCbPtr = mod.addFunction((level, fmtPtr) => {
            try { log(mod.UTF8ToString(fmtPtr)); } catch {}
          }, 'viii');
        }
        mod.setValue(dataPtr, state._logCbPtr, 'i32');
        return true;
      }

      case E.SET_VARIABLES: {
        let ptr = dataPtr;
        while (true) {
          const keyPtr = mod.getValue(ptr, 'i32');
          const descPtr = mod.getValue(ptr + 4, 'i32');
          if (keyPtr === 0) break;
          const key = mod.UTF8ToString(keyPtr);
          const desc = descPtr ? mod.UTF8ToString(descPtr) : '';
          const semi = desc.indexOf('; ');
          if (semi >= 0) {
            const options = desc.substring(semi + 2).split('|');
            const prior = state.coreVariables.get(key);
            const keep = prior && options.includes(prior.value) ? prior.value : options[0];
            state.coreVariables.set(key, { options, value: keep });
          }
          ptr += 8;
        }
        return true;
      }
      case E.SET_CORE_OPTIONS:
      case E.SET_CORE_OPTIONS_INTL:
      case E.SET_CORE_OPTIONS_V2:
      case E.SET_CORE_OPTIONS_V2_INTL:
      case E.SET_CORE_OPTIONS_DISPLAY:
        return true; // accept; forced defaults via GET_VARIABLE stand

      case E.GET_VARIABLE: {
        const keyPtr = mod.getValue(dataPtr, 'i32');
        if (keyPtr === 0) return false;
        const key = mod.UTF8ToString(keyPtr);
        const v = state.coreVariables.get(key);
        if (!v) { mod.setValue(dataPtr + 4, 0, 'i32'); return false; }
        mod.setValue(dataPtr + 4, allocStr(v.value), 'i32');
        return true;
      }
      case E.GET_VARIABLE_UPDATE:
        mod.setValue(dataPtr, state.variablesUpdated ? 1 : 0, 'i8');
        state.variablesUpdated = false;
        return true;

      case E.SET_HW_RENDER: {
        // retro_hw_render_callback: +0 type, +4 context_reset, +8 get_current_framebuffer,
        // +12 get_proc_address, +18 bottom_left_origin, +32 context_destroy.
        state.hw.contextResetPtr = mod.getValue(dataPtr + 4, 'i32');
        state.hw.bottomLeft = !!mod.HEAPU8[dataPtr + 18];
        state.hw.contextDestroyPtr = mod.getValue(dataPtr + 32, 'i32');
        // get_current_framebuffer → 0 (render to the canvas default framebuffer)
        const getFb = mod.addFunction(() => 0, 'i');
        // get_proc_address → emscripten's own WebGL resolver (real function pointers)
        const getProc = mod.addFunction((symPtr) => mod._emscripten_GetProcAddress(symPtr) >>> 0, 'ii');
        mod.setValue(dataPtr + 8, getFb, 'i32');
        mod.setValue(dataPtr + 12, getProc, 'i32');
        state.hw.active = true;
        return true;
      }

      default:
        return false; // reject everything else → core falls back to defaults
    }
  }

  // input: held bitmask for port 0
  const held = new Set();
  const inputState = mod.addFunction((port, device, index, id) => {
    if (port !== 0) return 0;
    // GET_INPUT_BITMASKS: id 0x100 asks for the whole mask
    if (id === 0x100) { let m = 0; for (const b of held) m |= (1 << b); return m; }
    for (const b of held) if (b === id) return 1;
    return 0;
  }, 'iiiii');

  // ---- 4. wire callbacks & init ----
  mod.addFunction; // (ensure present)
  const envCb = mod.addFunction(environ, 'iii');
  mod._retro_set_environment(envCb);
  mod._retro_init();

  const videoRefresh = mod.addFunction(() => {}, 'viiii'); // hw render: frame already on canvas
  const audioBatch = mod.addFunction((ptr, frames) => frames, 'iii'); // drop audio for now (return consumed)
  const audioSample = mod.addFunction(() => {}, 'vii');
  const inputPoll = mod.addFunction(() => {}, 'v');
  mod._retro_set_video_refresh(videoRefresh);
  mod._retro_set_audio_sample_batch(audioBatch);
  mod._retro_set_audio_sample(audioSample);
  mod._retro_set_input_poll(inputPoll);
  mod._retro_set_input_state(inputState);

  // ---- 5. load the ROM (into MEMFS; core reads the bytes) ----
  status('loading game…');
  try { mod.FS.mkdir('/system'); } catch {}
  const name = romName || 'game.elf';
  const path = '/' + name.replace(/[^\w.\-]/g, '_');
  mod.FS.writeFile(path, romBytes);

  const pathPtr = allocStr(path);
  const dataPtr = mod._malloc(romBytes.length);
  mod.HEAPU8.set(romBytes, dataPtr);
  const infoPtr = mod._malloc(16);
  mod.setValue(infoPtr + 0, pathPtr, 'i32');
  mod.setValue(infoPtr + 4, dataPtr, 'i32');
  mod.setValue(infoPtr + 8, romBytes.length, 'i32');
  mod.setValue(infoPtr + 12, 0, 'i32');
  const ok = mod._retro_load_game(infoPtr);
  mod._free(infoPtr);
  if (!ok) throw new Error('the core rejected this file (not a Dreamcast disc image or KOS .elf it can boot)');

  // AV info → size the canvas
  const avPtr = mod._malloc(64);
  mod._retro_get_system_av_info(avPtr);
  const baseW = mod.getValue(avPtr, 'i32') || 640;
  const baseH = mod.getValue(avPtr + 4, 'i32') || 480;
  mod._free(avPtr);
  canvas.width = baseW; canvas.height = baseH;

  // GL context is live and current → fire the core's context_reset so it builds its renderer.
  mod.GL.makeContextCurrent(glCtx);
  if (state.hw.contextResetPtr) mod.dynCall('v', state.hw.contextResetPtr, []);

  status('running');
  log(`Dreamcast core running — ${baseW}×${baseH}, reios HLE.`);

  // ---- 6. the frame loop ----
  let running = true, raf = 0, frames = 0;
  function frame() {
    if (!running) return;
    mod.GL.makeContextCurrent(glCtx);
    try { mod._retro_run(); frames++; }
    catch (e) {
      running = false;
      const detail = (e && e.message) || (e && e.stack) || (typeof e === 'number' ? 'wasm trap #' + e : String(e));
      log('core stopped after ' + frames + ' frame(s): ' + detail);
      status('halted');
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setButton(name, down) { const b = JOYPAD[name]; if (b === undefined) return; if (down) held.add(b); else held.delete(b); },
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running) { running = true; raf = requestAnimationFrame(frame); } },
    stop() { running = false; cancelAnimationFrame(raf); try { mod._retro_unload_game(); mod._retro_deinit(); } catch {} },
    dims() { return { w: canvas.width, h: canvas.height }; },
    frameCount() { return frames; },
  };
}
