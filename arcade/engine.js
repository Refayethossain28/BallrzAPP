/* Arcade — the pure game-console engine.
 * =====================================================================
 * Arcade is a pocket console: one dark handheld shell with a d-pad, two
 * buttons and a cartridge rack of tiny games — Serpent (snake), Fuse 2048
 * (slide-and-merge) and Breaker (brick-breaking). Every rule of every
 * game — how the serpent grows and dies, how tiles slide and fuse, how the
 * ball ricochets off bricks and paddle, and how the console keeps its
 * high-score table — lives HERE as pure, deterministic functions with zero
 * DOM and zero I/O. Randomness is seeded (FNV-1a) so the same seed always
 * deals the same game; anything time-dependent takes `now` as a parameter.
 * Unit-tested in scripts/test-arcade-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  /* ---------------- the cartridge rack ---------------- */
  var GAMES = [
    { id: 'serpent', name: 'Serpent', emoji: '🐍',
      tagline: 'Eat, grow, don’t bite yourself.',
      controls: 'D-pad steers · any direction starts' },
    { id: 'fuse', name: 'Fuse 2048', emoji: '🧊',
      tagline: 'Slide tiles, fuse pairs, chase 2048.',
      controls: 'D-pad slides the whole board' },
    { id: 'breaker', name: 'Breaker', emoji: '🧱',
      tagline: 'One ball, three lives, a wall to demolish.',
      controls: '◀ ▶ moves the paddle · A launches' },
    // A versus cartridge: two players, no high score — first to 7 wins.
    // Playable on one console or over the internet (invite codes).
    { id: 'pong', name: 'Versus', emoji: '🏓', versus: true, badge: '2P VS',
      tagline: 'Neon pong — same couch, two pads, or across the internet.',
      controls: 'W/S vs ▲▼ · gamepads & touch · online invite codes' },
    // External cartridges: not built-in engine games but whole other
    // machines slotted into the rack — the shell boots each in-screen.
    // `core` is the system the Ultra deck preselects ('' = show the picker).
    { id: 'ultra64', name: 'Ultra 64', emoji: '🎮', external: true, core: 'n64', badge: 'REAL N64',
      tagline: 'Real N64 — the mupen64plus core. Bring a ROM you own.',
      controls: 'Boots in-screen · B ejects the cartridge' },
    { id: 'omni', name: 'OmniCart', emoji: '📼', external: true, core: '', badge: '26 SYSTEMS',
      tagline: 'Every console + arcade — 26 systems of real cores.',
      controls: 'Pick a system in-screen · B ejects' },
    // `machine` boots the Ultra CPU-interpreter page instead of the core
    // player: no WASM Dreamcast core exists anywhere, so this slot runs
    // Ultra's from-scratch SH-4 with its homebrew shelf and live debugger.
    { id: 'dreamcast', name: 'Dreamcast', emoji: '🌀', external: true, machine: 'dc', badge: 'SH-4 LIVE',
      tagline: 'A real Hitachi SH-4 interpreter — homebrew shelf, live CPU.',
      controls: 'Boots in-screen · B ejects the cartridge' }
  ];

  function gameById(id) {
    for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i];
    return null;
  }

  /* ================================================================
   * SERPENT — the snake
   * A 16×16 garden with walls that bite back. The serpent moves one
   * cell per tick, grows by one when it eats, and every apple lands on
   * a seed-chosen free cell — same seed, same breakfast, forever.
   * ================================================================ */
  var SNAKE_COLS = 16, SNAKE_ROWS = 16;
  var DIRS = {
    up:    { x: 0,  y: -1 },
    down:  { x: 0,  y: 1 },
    left:  { x: -1, y: 0 },
    right: { x: 1,  y: 0 }
  };

  function oppositeDir(a, b) {
    return !!(DIRS[a] && DIRS[b]) && DIRS[a].x === -DIRS[b].x && DIRS[a].y === -DIRS[b].y;
  }

  function snakeFreeCells(cols, rows, snake) {
    var taken = {};
    for (var i = 0; i < snake.length; i++) taken[snake[i].x + ':' + snake[i].y] = 1;
    var free = [];
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (!taken[x + ':' + y]) free.push({ x: x, y: y });
      }
    }
    return free;
  }

  // The nth apple of a given seed always lands on the same free cell.
  function placeFood(cols, rows, snake, seed, n) {
    var free = snakeFreeCells(cols, rows, snake);
    if (!free.length) return null;
    return free[Math.floor(rand01('food:' + seed + ':' + n) * free.length)];
  }

  function newSnake(seed) {
    seed = String(seed == null ? 'serpent' : seed);
    var cx = Math.floor(SNAKE_COLS / 2), cy = Math.floor(SNAKE_ROWS / 2);
    var snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
    return {
      cols: SNAKE_COLS, rows: SNAKE_ROWS, seed: seed,
      snake: snake, dir: 'right',
      food: placeFood(SNAKE_COLS, SNAKE_ROWS, snake, seed, 0),
      score: 0, eaten: 0, steps: 0, alive: true
    };
  }

  // One tick. `want` is the direction the player is holding — ignored if it
  // would fold the serpent back into its own neck. Pure: returns a new state.
  function stepSnake(state, want) {
    if (!state.alive) return state;
    var dir = (want && DIRS[want] && !oppositeDir(want, state.dir)) ? want : state.dir;
    var d = DIRS[dir], head = state.snake[0];
    var nx = head.x + d.x, ny = head.y + d.y;
    var eats = !!state.food && nx === state.food.x && ny === state.food.y;

    var died = nx < 0 || ny < 0 || nx >= state.cols || ny >= state.rows;
    if (!died) {
      // the tail cell vacates this tick unless the serpent is growing into it
      var body = eats ? state.snake : state.snake.slice(0, -1);
      for (var i = 0; i < body.length; i++) {
        if (body[i].x === nx && body[i].y === ny) { died = true; break; }
      }
    }
    if (died) {
      return {
        cols: state.cols, rows: state.rows, seed: state.seed,
        snake: state.snake, dir: dir, food: state.food,
        score: state.score, eaten: state.eaten, steps: state.steps + 1, alive: false
      };
    }

    var snake = [{ x: nx, y: ny }].concat(eats ? state.snake : state.snake.slice(0, -1));
    var eaten = state.eaten + (eats ? 1 : 0);
    return {
      cols: state.cols, rows: state.rows, seed: state.seed,
      snake: snake, dir: dir,
      food: eats ? placeFood(state.cols, state.rows, snake, state.seed, eaten) : state.food,
      score: state.score + (eats ? 10 : 0),
      eaten: eaten, steps: state.steps + 1, alive: true
    };
  }

  // The serpent quickens as it scores: 160ms per tick down to a 70ms floor.
  function snakeSpeedMs(score) {
    return Math.max(70, 160 - Math.floor((score || 0) / 50) * 10);
  }

  /* ================================================================
   * FUSE 2048 — slide and merge
   * The classic 4×4: every swipe slides all tiles, equal neighbours
   * fuse once per move, and a new 2 (or, one time in ten, a 4) drops
   * on a seed-chosen free cell only when something actually moved.
   * ================================================================ */
  var FUSE_SIZE = 4;

  // Slide one row toward index 0, fusing equal pairs once each.
  function slideLeft(row) {
    var vals = [];
    for (var i = 0; i < row.length; i++) if (row[i]) vals.push(row[i]);
    var out = [], gained = 0;
    for (var j = 0; j < vals.length; j++) {
      if (j + 1 < vals.length && vals[j] === vals[j + 1]) {
        out.push(vals[j] * 2);
        gained += vals[j] * 2;
        j++;
      } else {
        out.push(vals[j]);
      }
    }
    while (out.length < row.length) out.push(0);
    var moved = false;
    for (var k = 0; k < row.length; k++) if (out[k] !== row[k]) { moved = true; break; }
    return { row: out, gained: gained, moved: moved };
  }

  // The i-th line of the board, in slide order, for a given direction.
  function lineCoords(dir, i) {
    var out = [];
    for (var j = 0; j < FUSE_SIZE; j++) {
      if (dir === 'left') out.push({ r: i, c: j });
      else if (dir === 'right') out.push({ r: i, c: FUSE_SIZE - 1 - j });
      else if (dir === 'up') out.push({ r: j, c: i });
      else out.push({ r: FUSE_SIZE - 1 - j, c: i }); // down
    }
    return out;
  }

  function copyBoard(b) {
    var out = [];
    for (var r = 0; r < b.length; r++) out.push(b[r].slice());
    return out;
  }

  function fuseFreeCells(board) {
    var free = [];
    for (var r = 0; r < FUSE_SIZE; r++) {
      for (var c = 0; c < FUSE_SIZE; c++) if (!board[r][c]) free.push({ r: r, c: c });
    }
    return free;
  }

  // Drop a new tile on a seeded free cell. `key` makes each spawn distinct.
  function spawnTile(board, seed, key) {
    var free = fuseFreeCells(board);
    if (!free.length) return board;
    var cell = free[Math.floor(rand01('cell:' + seed + ':' + key) * free.length)];
    var out = copyBoard(board);
    out[cell.r][cell.c] = rand01('val:' + seed + ':' + key) < 0.9 ? 2 : 4;
    return out;
  }

  function canMove2048(board) {
    for (var r = 0; r < FUSE_SIZE; r++) {
      for (var c = 0; c < FUSE_SIZE; c++) {
        if (!board[r][c]) return true;
        if (c + 1 < FUSE_SIZE && board[r][c] === board[r][c + 1]) return true;
        if (r + 1 < FUSE_SIZE && board[r][c] === board[r + 1][c]) return true;
      }
    }
    return false;
  }

  function highestTile(board) {
    var best = 0;
    for (var r = 0; r < FUSE_SIZE; r++) {
      for (var c = 0; c < FUSE_SIZE; c++) if (board[r][c] > best) best = board[r][c];
    }
    return best;
  }

  function new2048(seed) {
    seed = String(seed == null ? 'fuse' : seed);
    var board = [];
    for (var r = 0; r < FUSE_SIZE; r++) board.push([0, 0, 0, 0]);
    board = spawnTile(board, seed, 'init0');
    board = spawnTile(board, seed, 'init1');
    return { seed: seed, board: board, score: 0, moves: 0, won: false, over: false };
  }

  // One swipe. If nothing slid, the board is untouched and no tile spawns.
  function move2048(state, dir) {
    if (state.over || !DIRS[dir]) return state;
    var board = copyBoard(state.board);
    var moved = false, gained = 0;
    for (var i = 0; i < FUSE_SIZE; i++) {
      var coords = lineCoords(dir, i);
      var row = [];
      for (var j = 0; j < coords.length; j++) row.push(board[coords[j].r][coords[j].c]);
      var slid = slideLeft(row);
      if (slid.moved) moved = true;
      gained += slid.gained;
      for (var k = 0; k < coords.length; k++) board[coords[k].r][coords[k].c] = slid.row[k];
    }
    if (!moved) return state;
    var moves = state.moves + 1;
    board = spawnTile(board, state.seed, 'm' + moves);
    return {
      seed: state.seed, board: board,
      score: state.score + gained, moves: moves,
      won: state.won || highestTile(board) >= 2048,
      over: !canMove2048(board)
    };
  }

  /* ================================================================
   * BREAKER — brick-breaking
   * A unit square: x and y both run 0..1, the paddle guards y≈0.92 and
   * five rows of bricks hang from the top. The step function is fixed
   * physics — same inputs, same trajectory — with the launch angle and
   * nothing else drawn from the seed.
   * ================================================================ */
  var BREAKER = {
    paddleW: 0.2, paddleH: 0.028, paddleY: 0.92,
    ballR: 0.018, baseSpeed: 0.6,
    brickCols: 7, brickRows: 5
  };

  function newBricks(level) {
    var cols = BREAKER.brickCols, rows = BREAKER.brickRows;
    var gap = 0.012, top = 0.1, h = 0.04;
    var w = (1 - gap * (cols + 1)) / cols;
    var bricks = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        bricks.push({
          x: gap + c * (w + gap), y: top + r * (h + gap), w: w, h: h,
          row: r, pts: (rows - r) * 10, alive: true
        });
      }
    }
    return bricks;
  }

  function bricksAlive(bricks) {
    var n = 0;
    for (var i = 0; i < bricks.length; i++) if (bricks[i].alive) n++;
    return n;
  }

  // Ball speed rises with level and with rubble cleared this board.
  function breakerSpeed(state) {
    var destroyed = state.bricks.length - bricksAlive(state.bricks);
    return BREAKER.baseSpeed + 0.08 * (state.level - 1) + Math.min(0.25, destroyed * 0.005);
  }

  function restingBall(paddleX) {
    return {
      x: paddleX,
      y: BREAKER.paddleY - BREAKER.paddleH / 2 - BREAKER.ballR,
      vx: 0, vy: 0
    };
  }

  function newBreaker(seed) {
    seed = String(seed == null ? 'breaker' : seed);
    return {
      seed: seed, level: 1, score: 0, lives: 3,
      paddleX: 0.5, ball: restingBall(0.5), stuck: true,
      bricks: newBricks(1), launches: 0, over: false
    };
  }

  // Send a stuck ball flying at a seeded angle (up, within ±35° of vertical).
  function launchBreaker(state) {
    if (!state.stuck || state.over) return state;
    var angle = (rand01('launch:' + state.seed + ':' + state.launches) - 0.5) * 1.2;
    var speed = breakerSpeed(state);
    var out = shallowBreaker(state);
    out.stuck = false;
    out.launches = state.launches + 1;
    out.ball = {
      x: state.ball.x, y: state.ball.y,
      vx: Math.sin(angle) * speed, vy: -Math.cos(angle) * speed
    };
    return out;
  }

  function shallowBreaker(s) {
    return {
      seed: s.seed, level: s.level, score: s.score, lives: s.lives,
      paddleX: s.paddleX, ball: s.ball, stuck: s.stuck,
      bricks: s.bricks, launches: s.launches, over: s.over
    };
  }

  // One fixed physics step. `paddleX` is where the player wants the paddle;
  // `dt` is seconds (the shell feeds a fixed 1/120). Pure and deterministic.
  function stepBreaker(state, paddleX, dt) {
    if (state.over) return state;
    var halfW = BREAKER.paddleW / 2, r = BREAKER.ballR;
    var px = Math.max(halfW, Math.min(1 - halfW, Number(paddleX) || 0));
    var out = shallowBreaker(state);
    out.paddleX = px;

    if (state.stuck) { out.ball = restingBall(px); return out; }

    var b = state.ball;
    var x = b.x + b.vx * dt, y = b.y + b.vy * dt;
    var vx = b.vx, vy = b.vy;

    // side and top walls
    if (x - r < 0) { x = r; vx = Math.abs(vx); }
    if (x + r > 1) { x = 1 - r; vx = -Math.abs(vx); }
    if (y - r < 0) { y = r; vy = Math.abs(vy); }

    // the paddle: only catches a falling ball, and steers it by where it hit
    var paddleTop = BREAKER.paddleY - BREAKER.paddleH / 2;
    if (vy > 0 && y + r >= paddleTop && y + r <= paddleTop + BREAKER.paddleH + 0.02 &&
        x >= px - halfW - r && x <= px + halfW + r) {
      var off = Math.max(-1, Math.min(1, (x - px) / halfW));
      var speed = breakerSpeed(state);
      var angle = off * 1.05; // up to ~60° from vertical
      vx = Math.sin(angle) * speed;
      vy = -Math.cos(angle) * speed;
      y = paddleTop - r;
    }

    // bricks: first overlapped brick dies; reflect along the shallower overlap
    var bricks = state.bricks, score = state.score, hitIdx = -1;
    for (var i = 0; i < bricks.length; i++) {
      var bk = bricks[i];
      if (!bk.alive) continue;
      if (x + r > bk.x && x - r < bk.x + bk.w && y + r > bk.y && y - r < bk.y + bk.h) {
        hitIdx = i;
        var overlapX = Math.min(x + r - bk.x, bk.x + bk.w - (x - r));
        var overlapY = Math.min(y + r - bk.y, bk.y + bk.h - (y - r));
        if (overlapX < overlapY) vx = -vx; else vy = -vy;
        score += bk.pts;
        break;
      }
    }
    if (hitIdx >= 0) {
      bricks = bricks.slice();
      var dead = bricks[hitIdx];
      bricks[hitIdx] = { x: dead.x, y: dead.y, w: dead.w, h: dead.h, row: dead.row, pts: dead.pts, alive: false };
    }
    out.bricks = bricks;
    out.score = score;

    // board cleared → next level, faster, ball back on the paddle
    if (bricksAlive(bricks) === 0) {
      out.level = state.level + 1;
      out.bricks = newBricks(out.level);
      out.stuck = true;
      out.ball = restingBall(px);
      return out;
    }

    // dropped past the paddle → a life gone, or the game with it
    if (y - r > 1) {
      out.lives = state.lives - 1;
      out.stuck = true;
      out.ball = restingBall(px);
      if (out.lives <= 0) { out.lives = 0; out.over = true; }
      return out;
    }

    out.ball = { x: x, y: y, vx: vx, vy: vy };
    return out;
  }

  /* ================================================================
   * VERSUS — two-player neon pong
   * A unit square again: paddles guard x≈0.05 and x≈0.95, walls top
   * and bottom, first to 7 points wins. The step function takes BOTH
   * players' paddle positions as inputs, so the same pure engine
   * drives couch play, two gamepads, and online play (the host feeds
   * in the remote paddle and streams the state back). Serve angles
   * are seeded; everything else is fixed physics — same inputs, same
   * rally, on both ends of the wire.
   * ================================================================ */
  var PONG = {
    paddleH: 0.18, paddleW: 0.02, paddleX: 0.05,
    ballR: 0.018, baseSpeed: 0.75, maxSpeed: 1.6, target: 7
  };

  // The nth serve of a given seed always leaves at the same angle,
  // alternating sides so neither player serves twice in a row.
  function pongServe(seed, serves) {
    var angle = (rand01('serve:' + seed + ':' + serves) - 0.5) * 1.1; // ±~31°
    var dir = serves % 2 === 0 ? 1 : -1;
    return {
      x: 0.5, y: 0.5,
      vx: Math.cos(angle) * PONG.baseSpeed * dir,
      vy: Math.sin(angle) * PONG.baseSpeed
    };
  }

  function newPong(seed) {
    seed = String(seed == null ? 'versus' : seed);
    return {
      seed: seed, ball: pongServe(seed, 0),
      p1Y: 0.5, p2Y: 0.5, scores: [0, 0],
      rally: 0, serves: 0, winner: null
    };
  }

  function pongSpeed(rally) {
    return Math.min(PONG.maxSpeed, PONG.baseSpeed + rally * 0.05);
  }

  function clampPaddle(y) {
    var h = PONG.paddleH / 2;
    return Math.max(h, Math.min(1 - h, Number(y) || 0.5));
  }

  // One fixed physics step. p1Y/p2Y are where each player wants their
  // paddle (left and right); dt is seconds. Pure and deterministic.
  function stepPong(state, p1Y, p2Y, dt) {
    if (state.winner != null) return state;
    var r = PONG.ballR, half = PONG.paddleH / 2;
    var y1 = clampPaddle(p1Y), y2 = clampPaddle(p2Y);
    var b = state.ball;
    var x = b.x + b.vx * dt, y = b.y + b.vy * dt;
    var vx = b.vx, vy = b.vy;
    var rally = state.rally;

    // top and bottom walls
    if (y - r < 0) { y = r; vy = Math.abs(vy); }
    if (y + r > 1) { y = 1 - r; vy = -Math.abs(vy); }

    // the paddles: reflect a crossing ball, steering by where it hit
    var leftFace = PONG.paddleX + PONG.paddleW / 2;
    var rightFace = 1 - PONG.paddleX - PONG.paddleW / 2;
    if (vx < 0 && b.x - r > leftFace && x - r <= leftFace && Math.abs(y - y1) <= half + r) {
      rally++;
      var off1 = Math.max(-1, Math.min(1, (y - y1) / half));
      var sp1 = pongSpeed(rally);
      vx = Math.cos(off1 * 0.9) * sp1;
      vy = Math.sin(off1 * 0.9) * sp1;
      x = leftFace + r;
    } else if (vx > 0 && b.x + r < rightFace && x + r >= rightFace && Math.abs(y - y2) <= half + r) {
      rally++;
      var off2 = Math.max(-1, Math.min(1, (y - y2) / half));
      var sp2 = pongSpeed(rally);
      vx = -Math.cos(off2 * 0.9) * sp2;
      vy = Math.sin(off2 * 0.9) * sp2;
      x = rightFace - r;
    }

    // past a paddle → a point, a fresh seeded serve, maybe the match
    var scores = state.scores, serves = state.serves, winner = state.winner;
    var ball = { x: x, y: y, vx: vx, vy: vy };
    var scored = false;
    if (x < -0.04) { scores = [scores[0], scores[1] + 1]; scored = true; }
    else if (x > 1.04) { scores = [scores[0] + 1, scores[1]]; scored = true; }
    if (scored) {
      serves = state.serves + 1;
      rally = 0;
      ball = pongServe(state.seed, serves);
      if (scores[0] >= PONG.target) winner = 0;
      else if (scores[1] >= PONG.target) winner = 1;
    }

    return {
      seed: state.seed, ball: ball, p1Y: y1, p2Y: y2,
      scores: scores, rally: rally, serves: serves, winner: winner
    };
  }

  /* ================================================================
   * The console: one high-score table for every cartridge
   * ================================================================ */

  // Record a finished run. Pure: hands back a fresh table with the game's
  // best, last score, play count and when the best was set (clock-injected).
  function recordScore(table, gameId, score, now) {
    table = table || {};
    score = Math.max(0, Math.floor(Number(score) || 0));
    var prev = table[gameId] || { best: 0, last: 0, plays: 0, ts: 0 };
    var isBest = score > prev.best;
    var out = {};
    for (var k in table) out[k] = table[k];
    out[gameId] = {
      best: isBest ? score : prev.best,
      last: score,
      plays: prev.plays + 1,
      ts: isBest ? now : prev.ts
    };
    return out;
  }

  function bestScore(table, gameId) {
    return (table && table[gameId] && table[gameId].best) || 0;
  }

  function isHighScore(table, gameId, score) {
    return Math.floor(Number(score) || 0) > bestScore(table, gameId);
  }

  function formatScore(n) {
    return String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  var E = {
    GAMES: GAMES, gameById: gameById,
    hashStr: hashStr, rand01: rand01,
    // serpent
    SNAKE_COLS: SNAKE_COLS, SNAKE_ROWS: SNAKE_ROWS, DIRS: DIRS,
    oppositeDir: oppositeDir, placeFood: placeFood,
    newSnake: newSnake, stepSnake: stepSnake, snakeSpeedMs: snakeSpeedMs,
    // fuse 2048
    FUSE_SIZE: FUSE_SIZE, slideLeft: slideLeft, lineCoords: lineCoords,
    spawnTile: spawnTile, canMove2048: canMove2048, highestTile: highestTile,
    new2048: new2048, move2048: move2048,
    // breaker
    BREAKER: BREAKER, newBricks: newBricks, bricksAlive: bricksAlive,
    breakerSpeed: breakerSpeed, newBreaker: newBreaker,
    launchBreaker: launchBreaker, stepBreaker: stepBreaker,
    // versus pong
    PONG: PONG, pongServe: pongServe, newPong: newPong,
    pongSpeed: pongSpeed, clampPaddle: clampPaddle, stepPong: stepPong,
    // console
    recordScore: recordScore, bestScore: bestScore,
    isHighScore: isHighScore, formatScore: formatScore
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.ArcadeEngine = E;
})(typeof self !== 'undefined' ? self : this);
