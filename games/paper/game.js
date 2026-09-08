// paper — a splix.io-style territory game.
// loop out through open land, return to your territory to claim the
// enclosed area — enemy land included, as long as no one stands in it.
// territory is contiguous: when a cut splits someone's holdings, the
// pieces holding neither them nor their largest side crumble back to
// no-man's-land, and a dead player's land crumbles with them.
// cross a trail to cut its owner down. walls and your own trail kill.
// first to 25% of the map wins.

const GRID = 96;
const VIEW = 36; // cells visible across the viewport
const WIN_PCT = 0.25;
const TICK_MS = 110;
const BAR_WIDTH = 14;
const MAX_FEED = 8;
const LOOP_SCALE = GRID / 56; // loop sizes were tuned on a 56 grid
const TRAIL_LIMIT = Math.round(45 * LOOP_SCALE);
const FLASH_MS = 350;
const CAM_LERP = 0.18;
const SWIPE_MIN = 24; // px before a touch counts as a swipe
const HUNT_MIN_BASE = 200; // territory needed before a bot starts hunting
const HUNT_MAX_TRAIL = 12; // own trail a bot will risk on a hunt
const HUNT_GIVEUP_TICKS = 90;

// 0=up 1=right 2=down 3=left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

const PALETTE = [
	{ name: "you", color: "#ff7a00", dim: "#53290a", head: "#ffae42" },
	{ name: "cron", color: "#4dd0e1", dim: "#16404a", head: "#a5ecf5" },
	{ name: "sudo", color: "#ff5fa2", dim: "#4e2036", head: "#ffa9cc" },
	{ name: "vim", color: "#8ce85e", dim: "#2f4d20", head: "#c8f7ab" },
	{ name: "gdb", color: "#e8d44d", dim: "#574c11", head: "#f6ea9d" },
	{ name: "emacs", color: "#b18cff", dim: "#3c2e5e", head: "#d7c7ff" },
];

const SPAWNS = [
	{ x: 24, y: 76, dir: 1 },
	{ x: 72, y: 20, dir: 3 },
	{ x: 72, y: 76, dir: 3 },
	{ x: 24, y: 20, dir: 1 },
	{ x: 24, y: 48, dir: 1 },
	{ x: 72, y: 48, dir: 3 },
];

// ---- state ----

let owner; // Int8Array, -1 = neutral, else player id
let trail; // Int8Array, -1 = none, else player id
let counts;
let players = [];
let state = "ready"; // ready | run | over
let paused = false;
let acc = 0;
let lastTime = 0;
let startTime = 0;
let flashes = [];
let deathMsg = "";
let dirtyTerritory = true;
let camX = -1; // viewport top-left in cells (float), -1 = snap on next frame
let camY = -1;

// scratch buffers, reused to avoid per-capture allocation
const floodSeen = new Uint8Array(GRID * GRID);
const floodQueue = new Int32Array(GRID * GRID);
const pocketId = new Int32Array(GRID * GRID);
const pocketAlive = new Int32Array(GRID * GRID);
const pocketQueue = new Int32Array(GRID * GRID);
const compId = new Int32Array(GRID * GRID);
const bfsSeen = new Uint8Array(GRID * GRID);
const bfsPrev = new Int32Array(GRID * GRID);
const bfsQueue = new Int32Array(GRID * GRID);

// ---- dom ----

const canvasEl = document.getElementById("game");
const ctx = canvasEl.getContext("2d");
const minimapEl = document.getElementById("minimap");
const minimapCtx = minimapEl.getContext("2d");
const overlayEl = document.getElementById("overlay");
const standingsEl = document.getElementById("standings");
const feedEl = document.getElementById("feed");
const mapCan = document.createElement("canvas"); // full-map minimap cache
const mapCtx = mapCan.getContext("2d");

let CPX = 11; // device pixels per cell

// ---- world ----

function initWorld() {
	owner = new Int8Array(GRID * GRID).fill(-1);
	trail = new Int8Array(GRID * GRID).fill(-1);
	players = PALETTE.map((pal, id) => ({ ...pal, id, isBot: id !== 0 }));
	counts = new Array(players.length).fill(0);
	players.forEach((p, i) => {
		const s = SPAWNS[i];
		p.x = s.x;
		p.y = s.y;
		p.px = s.x;
		p.py = s.y;
		p.dir = s.dir;
		p.queue = [];
		p.alive = true;
		p.kills = 0;
		p.trailCells = [];
		p.mode = "out";
		p.waypoints = [];
		p.aggression = 0.2 + Math.random() * 0.7;
		p.hunt = null;
		p.huntTicks = 0;
		// personality: size appetite, favored shape and turning side,
		// jitteriness, hunting range — every bot reads differently
		p.bigness = 0.7 + Math.random() * 0.8;
		p.wander = 0.01 + Math.random() * 0.04;
		p.lefty = Math.random() < 0.5;
		p.huntR = 6 + ((Math.random() * 5) | 0);
		p.style = ["loop", "stripe", "sweep"][(Math.random() * 3) | 0];
		claimBase(p);
	});
	flashes = [];
	deathMsg = "";
	camX = -1;
	camY = -1;
	dirtyTerritory = true;
	feedEl.innerHTML = "";
	updateHUD();
}

function claimBase(p) {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			owner[(p.y + dy) * GRID + (p.x + dx)] = p.id;
		}
	}
	counts[p.id] = 25;
}

function setOwner(ci, id) {
	const old = owner[ci];
	if (old === id) return;
	if (old >= 0) counts[old]--;
	owner[ci] = id;
	if (id >= 0) counts[id]++;
	dirtyTerritory = true;
}

// ---- mechanics ----

function tick() {
	for (const p of players) {
		if (!p.alive) continue;
		if (p.isBot) botSteer(p);
		else applyQueue(p);
		stepPlayer(p);
	}
	checkWin();
	updateHUD();
}

function applyQueue(p) {
	while (p.queue.length) {
		const d = p.queue.shift();
		if (d !== p.dir && d !== (p.dir + 2) % 4) {
			p.dir = d;
			break;
		}
	}
}

function stepPlayer(p) {
	const nx = p.x + DX[p.dir];
	const ny = p.y + DY[p.dir];
	p.px = p.x;
	p.py = p.y;
	if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) {
		kill(p, "wall");
		return;
	}
	const ci = ny * GRID + nx;
	for (const q of players) {
		if (q !== p && q.alive && q.x === nx && q.y === ny) {
			kill(p, "head", q);
			kill(q, "head", p);
			return;
		}
	}
	const t = trail[ci];
	if (t === p.id) {
		kill(p, "self");
		return;
	}
	if (t >= 0) kill(players[t], "cut", p); // crossing a trail cuts its owner down
	p.x = nx;
	p.y = ny;
	if (owner[ci] === p.id) {
		if (p.trailCells.length) capture(p);
	} else {
		trail[ci] = p.id;
		p.trailCells.push(ci);
	}
}

function kill(p, cause, killer) {
	if (!p.alive) return;
	p.alive = false;
	clearTrail(p);
	if (killer && killer !== p) killer.kills++;
	if (cause === "wall") feed(`${nameHtml(p)} hit a wall`);
	else if (cause === "self") feed(`${nameHtml(p)} hit their own trail`);
	else if (cause === "cut") feed(`${nameHtml(killer)} cut down ${nameHtml(p)}`);
	else if (cause === "head") feed(`${nameHtml(p)} collided with ${nameHtml(killer)}`);
	else if (cause === "captured") feed(`${nameHtml(killer)} cut off ${nameHtml(p)}`);
	else if (cause === "stranded") feed(`${nameHtml(p)} was stranded with no land`);
	if (!p.isBot) deathMsg = deathText(cause, killer);
	// remember the holding size for the death screen, then a dead
	// player's holdings crumble with them
	const deadLand = [];
	for (let i = 0; i < GRID * GRID; i++) {
		if (owner[i] === p.id) deadLand.push(i);
	}
	p.finalPct = (deadLand.length / (GRID * GRID)) * 100;
	if (deadLand.length) {
		for (const ci of deadLand) setOwner(ci, -1);
		flashes.push({ cells: deadLand, t0: performance.now(), color: p.color });
	}
}

function deathText(cause, killer) {
	if (cause === "wall") return "you flew into a wall";
	if (cause === "self") return "you crossed your own trail";
	if (cause === "cut") return `cut down by ${killer ? killer.name : "someone"}`;
	if (cause === "head") return "head-on collision";
	if (cause === "captured") return `your trail was cut off by ${killer ? killer.name : "someone"}`;
	if (cause === "stranded") return "your whole base was cut away — nothing left to come home to";
	return "you died";
}

function clearTrail(p) {
	for (const ci of p.trailCells) {
		if (trail[ci] === p.id) trail[ci] = -1;
	}
	p.trailCells = [];
}

// mark every cell reachable from the map border without crossing
// p's land — whatever stays unreached is enclosed by the capture
function floodOutside(p) {
	floodSeen.fill(0);
	let head = 0;
	let tail = 0;
	const push = (ci) => {
		floodSeen[ci] = 1;
		floodQueue[tail++] = ci;
	};
	for (let i = 0; i < GRID; i++) {
		for (const ci of [i, (GRID - 1) * GRID + i, i * GRID, i * GRID + GRID - 1]) {
			if (owner[ci] !== p.id && !floodSeen[ci]) push(ci);
		}
	}
	while (head < tail) {
		const ci = floodQueue[head++];
		const cx = ci % GRID;
		const cy = (ci / GRID) | 0;
		if (cx > 0 && !floodSeen[ci - 1] && owner[ci - 1] !== p.id) push(ci - 1);
		if (cx < GRID - 1 && !floodSeen[ci + 1] && owner[ci + 1] !== p.id) push(ci + 1);
		if (cy > 0 && !floodSeen[ci - GRID] && owner[ci - GRID] !== p.id) push(ci - GRID);
		if (cy < GRID - 1 && !floodSeen[ci + GRID] && owner[ci + GRID] !== p.id) push(ci + GRID);
	}
}

// group the enclosed cells into connected pockets — pocket ids are
// written into pocketId; returns the number of pockets found
function labelPockets(p) {
	pocketId.fill(-1);
	let pockets = 0;
	for (let i = 0; i < GRID * GRID; i++) {
		if (floodSeen[i] || owner[i] === p.id || pocketId[i] !== -1) continue;
		const pid = pockets++;
		pocketId[i] = pid;
		let qh = 0;
		let qt = 0;
		pocketQueue[qt++] = i;
		while (qh < qt) {
			const ci = pocketQueue[qh++];
			const cx = ci % GRID;
			const cy = (ci / GRID) | 0;
			const spread = (ni) => {
				if (floodSeen[ni] || owner[ni] === p.id || pocketId[ni] !== -1) return;
				pocketId[ni] = pid;
				pocketQueue[qt++] = ni;
			};
			if (cx > 0) spread(ci - 1);
			if (cx < GRID - 1) spread(ci + 1);
			if (cy > 0) spread(ci - GRID);
			if (cy < GRID - 1) spread(ci + GRID);
		}
	}
	return pockets;
}

// label q's territory into connected pieces by same-owner adjacency —
// piece ids are written into compId; returns piece sizes by id
function labelPieces(q) {
	compId.fill(-1);
	let nComp = 0;
	const sizes = [];
	for (let i = 0; i < GRID * GRID; i++) {
		if (owner[i] !== q.id || compId[i] !== -1) continue;
		const cid = nComp++;
		let size = 0;
		let qh = 0;
		let qt = 0;
		compId[i] = cid;
		pocketQueue[qt++] = i;
		while (qh < qt) {
			const ci = pocketQueue[qh++];
			size++;
			const cx = ci % GRID;
			const cy = (ci / GRID) | 0;
			const spread = (ni) => {
				if (owner[ni] !== q.id || compId[ni] !== -1) return;
				compId[ni] = cid;
				pocketQueue[qt++] = ni;
			};
			if (cx > 0) spread(ci - 1);
			if (cx < GRID - 1) spread(ci + 1);
			if (cy > 0) spread(ci - GRID);
			if (cy < GRID - 1) spread(ci + GRID);
		}
		sizes[cid] = size;
	}
	return sizes;
}

function capture(p) {
	// the trail becomes territory — the cutting line
	for (const ci of p.trailCells) {
		if (trail[ci] === p.id) trail[ci] = -1;
		setOwner(ci, p.id);
	}
	p.trailCells = [];

	// what does the line enclose? (a knife wall may enclose nothing —
	// the passes below still apply either way)
	floodOutside(p);
	const pockets = labelPockets(p);

	// a pocket someone is standing in stays exactly as it is — you
	// can't cut off the side someone is on
	pocketAlive.fill(0, 0, pockets);
	for (const q of players) {
		if (q === p || !q.alive) continue;
		const ci = q.y * GRID + q.x;
		if (!floodSeen[ci] && owner[ci] !== p.id && pocketId[ci] !== -1) {
			pocketAlive[pocketId[ci]] = 1;
		}
	}

	// a trail caught inside a resolving pocket is cut off — its owner dies
	for (const q of players) {
		if (q === p || !q.alive) continue;
		for (const ci of q.trailCells) {
			if (pocketId[ci] !== -1 && !pocketAlive[pocketId[ci]]) {
				kill(q, "captured", p);
				break;
			}
		}
	}

	// resolve no-head pockets: the capturer takes everything inside
	// the loop, enemy land included. (live owners' enclosed land is
	// claimed directly here — the island pass only governs land
	// outside the loop that's cut off from its owner)
	const claimed = [];
	for (let i = 0; i < GRID * GRID; i++) {
		if (floodSeen[i]) continue;
		const pk = pocketId[i];
		if (pk === -1 || pocketAlive[pk]) continue;
		if (owner[i] !== p.id) claimed.push(i);
	}
	for (const ci of claimed) setOwner(ci, p.id);

	// contiguity pass: a cut can split a victim's holdings into pieces.
	// every piece that holds neither their head (when they stand on
	// their own land) nor their largest side crumbles back to
	// no-man's-land. pieces are judged by same-owner adjacency only —
	// open floor between them doesn't connect anything.
	const vanished = new Map();
	for (const q of players) {
		if (q === p || !q.alive || counts[q.id] === 0) continue;
		const sizes = labelPieces(q);
		if (sizes.length <= 1) continue;
		const headComp = compId[q.y * GRID + q.x];
		let largest = 0;
		for (let c = 1; c < sizes.length; c++) {
			if (sizes[c] > sizes[largest]) largest = c;
		}
		for (let i = 0; i < GRID * GRID; i++) {
			if (owner[i] !== q.id) continue;
			const c = compId[i];
			if (c === headComp || c === largest) continue;
			setOwner(i, -1);
			if (!vanished.has(q)) vanished.set(q, []);
			vanished.get(q).push(i);
		}
	}

	// stranded: an owner whose entire holding was cut away has nothing
	// to come home to
	for (const q of players) {
		if (q !== p && q.alive && counts[q.id] === 0) kill(q, "stranded", p);
	}

	const now = performance.now();
	if (claimed.length) {
		flashes.push({ cells: claimed, t0: now, color: p.head });
		feed(`${nameHtml(p)} captured ${claimed.length} cells`);
	}
	for (const [q, cells] of vanished) {
		flashes.push({ cells, t0: now, color: q.color });
		feed(`${nameHtml(q)} lost ${cells.length} cells to the void`);
	}
}

function checkWin() {
	if (state !== "run") return;
	const total = GRID * GRID;
	for (const p of players) {
		if (p.alive && counts[p.id] / total >= WIN_PCT) {
			endGame(p, "territory");
			return;
		}
	}
	const alive = players.filter((p) => p.alive);
	const you = players[0];
	if (!you.alive) {
		endGame(alive.length === 1 ? alive[0] : null, "died");
		return;
	}
	if (alive.length === 1) {
		endGame(you, "outlasted");
		return;
	}
	if (alive.length === 0) endGame(null, "mutual");
}

function endGame(winner, reason) {
	state = "over";
	const you = players[0];
	const secs = Math.max(1, Math.round((Date.now() - startTime) / 1000));
	const mm = Math.floor(secs / 60);
	const ss = String(secs % 60).padStart(2, "0");
	const pct = (you.alive ? (counts[0] / (GRID * GRID)) * 100 : you.finalPct).toFixed(1);
	let title;
	let sub;
	if (winner === you) {
		title = "you win";
		sub = reason === "territory" ? `you hit ${Math.round(WIN_PCT * 100)}% first` : "last one standing";
	} else if (winner) {
		title = "you lose";
		sub = reason === "territory" ? `${winner.name} hit ${Math.round(WIN_PCT * 100)}% first` : `${winner.name} is the last one standing`;
	} else {
		title = "you died";
		sub = reason === "mutual" ? "mutual destruction — nobody wins" : deathMsg;
	}
	showOverlay(`
		<div class="ov-inner">
			<p class="ov-title">${title}<span class="cursor">_</span></p>
			<p class="ov-line">${sub}</p>
			<p class="ov-stats">${pct}% territory &middot; ${you.kills} kill${you.kills === 1 ? "" : "s"} &middot; ${mm}:${ss} survived</p>
			<p class="ov-go">press R or tap to play again</p>
		</div>
	`);
}

// ---- bot ai ----

function botSteer(bot) {
	// opportunistic cut: stepping on an enemy trail kills its owner —
	// take any trail that's adjacent or lined up ahead, as long as the
	// kill cell has breathing room and a way home
	const cut = cutDirection(bot);
	if (cut !== -1 && (cut.urgent || Math.random() < bot.aggression)) {
		const nx = bot.x + DX[cut.d];
		const ny = bot.y + DY[cut.d];
		if (exitsFrom(bot, nx, ny) > 0 && canReachHome(bot, nx, ny)) {
			bot.dir = cut.d;
			return;
		}
	}

	// hunting: a nearby enemy trail is a kill worth chasing instead of
	// mindlessly painting — but only once established (a solid base to
	// come home to), with a short enough trail to afford the detour,
	// and in line with the bot's appetite
	if (bot.hunt && !huntValid(bot)) bot.hunt = null;
	if (!bot.hunt && counts[bot.id] > HUNT_MIN_BASE && bot.trailCells.length <= HUNT_MAX_TRAIL && Math.random() < bot.aggression * 0.5) {
		const target = findHuntTarget(bot);
		if (target) {
			bot.hunt = target;
			bot.huntTicks = 0;
		}
	}
	if (bot.hunt) {
		bot.huntTicks++;
		if (bot.huntTicks > HUNT_GIVEUP_TICKS || bot.trailCells.length > TRAIL_LIMIT - 10) {
			bot.hunt = null; // too slow or getting too risky — give up
		} else {
			const d = safeStepToward(bot, bot.hunt.x, bot.hunt.y);
			if (d === -1) bot.hunt = null;
			else {
				bot.dir = d;
				return;
			}
		}
	}

	for (let guard = 0; guard < 5; guard++) {
		if (bot.mode === "out") {
			// circuit breaker: a healthy loop never leaves a trail this
			// long — if we're way past it, the way home is closing; go
			// back NOW rather than wrapping ourselves in
			if (bot.trailCells.length > TRAIL_LIMIT) {
				bot.mode = "home";
				bot.waypoints = [];
				bot.hunt = null;
			}
			if (!bot.waypoints.length) planLoop(bot);
			if (!bot.waypoints.length) {
				bot.mode = "home";
				continue;
			}
			const wp = bot.waypoints[0];
			if (bot.x === wp.x && bot.y === wp.y) {
				bot.waypoints.shift();
				continue;
			}
			// wander: occasional safe kink so paths don't look drawn
			// with a ruler — never one that strands us from home
			if (Math.random() < bot.wander) {
				const turn = (bot.dir + (Math.random() < 0.5 ? 1 : 3)) % 4;
				const wx = bot.x + DX[turn];
				const wy = bot.y + DY[turn];
				if (!deadly(bot, wx, wy) && exitsFrom(bot, wx, wy) > 0 && canReachHome(bot, wx, wy)) {
					bot.dir = turn;
					return;
				}
			}
			const d = safeStepToward(bot, wp.x, wp.y);
			if (d !== -1) {
				bot.dir = d;
				return;
			}
			bot.mode = "home";
			continue;
		}
		// heading home to close the loop
		if (bot.trailCells.length === 0 && owner[bot.y * GRID + bot.x] === bot.id) {
			bot.mode = "out";
			bot.waypoints = [];
			continue;
		}
		const next = bfsHome(bot);
		if (next !== -1) {
			const nx = next % GRID;
			const ny = (next / GRID) | 0;
			if (exitsFrom(bot, nx, ny) > 0) {
				bot.dir = dirFromTo(bot.x, bot.y, nx, ny);
				return;
			}
		}
		if (bot.trailCells.length === 0) {
			// territory gone entirely — go reclaim somewhere
			bot.mode = "out";
			bot.waypoints = [];
		}
		greedySafe(bot);
		return;
	}
	greedySafe(bot);
}

function cutDirection(bot) {
	for (let d = 0; d < 4; d++) {
		const nx = bot.x + DX[d];
		const ny = bot.y + DY[d];
		if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
		if (headAt(nx, ny, bot)) continue; // stepping onto a head is mutual death
		const t = trail[ny * GRID + nx];
		if (t >= 0 && t !== bot.id && players[t].alive) return { d, urgent: true };
	}
	// two ahead along the current heading
	const fx = bot.x + DX[bot.dir] * 2;
	const fy = bot.y + DY[bot.dir] * 2;
	if (fx >= 0 && fy >= 0 && fx < GRID && fy < GRID) {
		const mx = bot.x + DX[bot.dir];
		const my = bot.y + DY[bot.dir];
		if (trail[my * GRID + mx] !== bot.id && !headAt(mx, my, bot) && !headAt(fx, fy, bot)) {
			const t = trail[fy * GRID + fx];
			if (t >= 0 && t !== bot.id && players[t].alive) {
				return { d: bot.dir, urgent: false };
			}
		}
	}
	return -1;
}

function openAhead(bot, d, max) {
	let x = bot.x;
	let y = bot.y;
	let n = 0;
	for (let i = 0; i < max; i++) {
		x += DX[d];
		y += DY[d];
		if (deadly(bot, x, y)) break;
		n++;
	}
	return n;
}

// nearest cell the bot owns (excluding where it stands) — an aim point
// for keeping loops opening toward home
function nearestOwnedCell(bot) {
	let bestDist = Infinity;
	let bx = -1;
	let by = -1;
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			if (owner[y * GRID + x] !== bot.id) continue;
			const d = Math.abs(x - bot.x) + Math.abs(y - bot.y);
			if (d > 0 && d < bestDist) {
				bestDist = d;
				bx = x;
				by = y;
			}
		}
	}
	return bx === -1 ? null : { x: bx, y: by };
}

function huntValid(bot) {
	const ci = bot.hunt.y * GRID + bot.hunt.x;
	return players[bot.hunt.prey].alive && trail[ci] === bot.hunt.prey;
}

// nearest enemy trail cell within hunting range — a kill worth chasing
function findHuntTarget(bot) {
	const R = bot.huntR;
	let best = null;
	let bestDist = Infinity;
	for (let dy = -R; dy <= R; dy++) {
		const y = bot.y + dy;
		if (y < 0 || y >= GRID) continue;
		for (let dx = -R; dx <= R; dx++) {
			const x = bot.x + dx;
			if (x < 0 || x >= GRID) continue;
			const dist = Math.abs(dx) + Math.abs(dy);
			if (dist > R || dist >= bestDist) continue;
			const t = trail[y * GRID + x];
			if (t < 0 || t === bot.id || !players[t].alive) continue;
			if (headAt(x, y, bot)) continue; // stepping onto a head is mutual death
			bestDist = dist;
			best = { x, y, prey: t };
		}
	}
	return best;
}

// nearest cell owned by an enemy — where the pressure should go
function nearestEnemyCell(bot) {
	let bestDist = Infinity;
	let bx = -1;
	let by = -1;
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const o = owner[y * GRID + x];
			if (o < 0 || o === bot.id || !players[o].alive) continue;
			const d = Math.abs(x - bot.x) + Math.abs(y - bot.y);
			if (d > 0 && d < bestDist) {
				bestDist = d;
				bx = x;
				by = y;
			}
		}
	}
	return bx === -1 ? null : { x: bx, y: by };
}

function planLoop(bot) {
	// out n1, across n2, back n1 — then bfs home closes the rectangle.
	// the outward leg points away from the nearest owned cell so the
	// mouth of the loop faces home — that's what keeps the way back
	// open instead of wrapping the trail around our own territory.
	// loops also lean toward enemy land: bots push borders, they don't
	// just paint empty corners
	let rx = 0;
	let ry = 0;
	const home = nearestOwnedCell(bot);
	if (home) {
		rx = bot.x - home.x;
		ry = bot.y - home.y;
	}
	let ex = 0;
	let ey = 0;
	const foe = nearestEnemyCell(bot);
	if (foe) {
		ex = foe.x - bot.x;
		ey = foe.y - bot.y;
	}
	const back = (bot.dir + 2) % 4;
	let d1 = bot.dir;
	let best = -1;
	for (let d = 0; d < 4; d++) {
		if (d === back) continue;
		let score = openAhead(bot, d, Math.round(10 * LOOP_SCALE)) + (d === bot.dir ? 2 : 0);
		if (DX[d] * rx + DY[d] * ry > 0) score += 8; // outward from home
		if (DX[d] * ex + DY[d] * ey > 0) score += 5; // toward the enemy
		if (score > best) {
			best = score;
			d1 = d;
		}
	}
	// bots favor their silhouette but mix it up so the rhythm never
	// turns metronomic: stripes are long deep tongues, sweeps are
	// wide shallow scoops, loops are the classic rectangle
	const styles = ["loop", "stripe", "sweep"];
	const style = Math.random() < 0.6 ? bot.style : styles[(Math.random() * 3) | 0];
	let n1;
	let n2;
	if (style === "stripe") {
		n1 = Math.round((8 + Math.random() * 8) * LOOP_SCALE * bot.bigness);
		n2 = Math.round((2 + Math.random() * 2) * LOOP_SCALE);
	} else if (style === "sweep") {
		n1 = Math.round((3 + Math.random() * 3) * LOOP_SCALE * bot.bigness);
		n2 = Math.round((8 + Math.random() * 8) * LOOP_SCALE * bot.bigness);
	} else {
		n1 = Math.round((4 + Math.random() * 6) * LOOP_SCALE * bot.bigness);
		n2 = Math.round((3 + Math.random() * 5) * LOOP_SCALE * bot.bigness);
	}
	n1 = Math.max(2, Math.min(24, n1));
	n2 = Math.max(2, Math.min(22, n2));
	// handedness breaks ties toward the bot's favored side
	const perps = [(d1 + 1) % 4, (d1 + 3) % 4];
	const prefer = bot.lefty ? perps[0] : perps[1];
	const other = bot.lefty ? perps[1] : perps[0];
	const look = Math.round(8 * LOOP_SCALE);
	const d2 = openAhead(bot, prefer, look) + 2 >= openAhead(bot, other, look) ? prefer : other;
	const clamp = (v) => Math.max(2, Math.min(GRID - 3, v));
	const w1 = { x: clamp(bot.x + DX[d1] * n1), y: clamp(bot.y + DY[d1] * n1) };
	const w2 = { x: clamp(w1.x + DX[d2] * n2), y: clamp(w1.y + DY[d2] * n2) };
	const w3 = { x: clamp(w2.x - DX[d1] * n1), y: clamp(w2.y - DY[d1] * n1) };
	bot.waypoints = [w1, w2, w3];
}

function safeStepToward(bot, tx, ty) {
	const dx = tx - bot.x;
	const dy = ty - bot.y;
	const prefs = [];
	const add = (d) => {
		if (!prefs.includes(d)) prefs.push(d);
	};
	if (Math.abs(dx) >= Math.abs(dy)) {
		if (dx > 0) add(1);
		if (dx < 0) add(3);
		if (dy > 0) add(2);
		if (dy < 0) add(0);
	} else {
		if (dy > 0) add(2);
		if (dy < 0) add(0);
		if (dx > 0) add(1);
		if (dx < 0) add(3);
	}
	add(bot.dir);
	add((bot.dir + 1) % 4);
	add((bot.dir + 3) % 4);
	// never step into a coffin, and never take a step that strands us
	// from home — a bot that can still walk home can always come back
	const pool = [];
	for (const d of prefs) {
		const nx = bot.x + DX[d];
		const ny = bot.y + DY[d];
		if (deadly(bot, nx, ny)) continue;
		const exits = exitsFrom(bot, nx, ny);
		if (exits === 0) continue;
		pool.push({ d, exits, home: canReachHome(bot, nx, ny), crowded: nearEnemyHead(bot, nx, ny) });
	}
	const tiers = [
		pool.filter((c) => c.home && !c.crowded),
		pool.filter((c) => c.home),
		pool.filter((c) => !c.crowded),
		pool,
	];
	let candidates = null;
	for (const tier of tiers) {
		if (tier.length) {
			candidates = tier;
			break;
		}
	}
	if (!candidates) return -1;
	let best = null;
	for (const c of candidates) {
		if (!best || c.exits > best.exits) best = c;
	}
	return best.d;
}

function deadly(bot, x, y) {
	if (x < 0 || y < 0 || x >= GRID || y >= GRID) return true;
	if (trail[y * GRID + x] === bot.id) return true;
	return headAt(x, y, bot);
}

// how many adjacent cells from (x, y) survive — a cell walled in by
// border and own trail is a coffin, however safe it looks to enter
function exitsFrom(bot, x, y) {
	let n = 0;
	for (let d = 0; d < 4; d++) {
		if (!deadly(bot, x + DX[d], y + DY[d])) n++;
	}
	return n;
}

function headAt(x, y, except) {
	for (const q of players) {
		if (q !== except && q.alive && q.x === x && q.y === y) return true;
	}
	return false;
}

function nearEnemyHead(bot, x, y) {
	for (let d = 0; d < 4; d++) {
		const nx = x + DX[d];
		const ny = y + DY[d];
		if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
		for (const q of players) {
			if (q !== bot && q.alive && q.x === nx && q.y === ny) return true;
		}
	}
	return false;
}

function bfsHome(bot) {
	bfsSeen.fill(0);
	let head = 0;
	let tail = 0;
	const start = bot.y * GRID + bot.x;
	bfsSeen[start] = 1;
	bfsPrev[start] = -1;
	bfsQueue[tail++] = start;
	while (head < tail) {
		const ci = bfsQueue[head++];
		if (owner[ci] === bot.id && ci !== start) {
			let node = ci;
			while (bfsPrev[node] !== start) node = bfsPrev[node];
			return node;
		}
		const cx = ci % GRID;
		const cy = (ci / GRID) | 0;
		for (let d = 0; d < 4; d++) {
			const nx = cx + DX[d];
			const ny = cy + DY[d];
			if (deadly(bot, nx, ny)) continue;
			const ni = ny * GRID + nx;
			if (bfsSeen[ni]) continue;
			bfsSeen[ni] = 1;
			bfsPrev[ni] = ci;
			bfsQueue[tail++] = ni;
		}
	}
	return -1;
}

// can the bot still walk home from (x, y) — crossing nothing deadly?
// a step that seals off every route home is a slow suicide, however
// safe the next cell itself looks (own trails ring closed)
function canReachHome(bot, x, y) {
	if (owner[y * GRID + x] === bot.id) return true;
	bfsSeen.fill(0);
	let head = 0;
	let tail = 0;
	const start = y * GRID + x;
	bfsSeen[start] = 1;
	bfsQueue[tail++] = start;
	while (head < tail) {
		const ci = bfsQueue[head++];
		const cx = ci % GRID;
		const cy = (ci / GRID) | 0;
		for (let d = 0; d < 4; d++) {
			const nx = cx + DX[d];
			const ny = cy + DY[d];
			if (deadly(bot, nx, ny)) continue;
			const ni = ny * GRID + nx;
			if (bfsSeen[ni]) continue;
			if (owner[ni] === bot.id) return true;
			bfsSeen[ni] = 1;
			bfsQueue[tail++] = ni;
		}
	}
	return false;
}

function dirFromTo(x, y, nx, ny) {
	if (nx > x) return 1;
	if (nx < x) return 3;
	if (ny > y) return 2;
	return 0;
}

function greedySafe(bot) {
	const prefs = [bot.dir, (bot.dir + 1) % 4, (bot.dir + 3) % 4, (bot.dir + 2) % 4];
	for (let pass = 0; pass < 2; pass++) {
		let best = null;
		for (const d of prefs) {
			const nx = bot.x + DX[d];
			const ny = bot.y + DY[d];
			if (deadly(bot, nx, ny)) continue;
			if (pass === 0 && nearEnemyHead(bot, nx, ny)) continue;
			const exits = exitsFrom(bot, nx, ny);
			if (exits === 0) continue; // coffins are not escape routes
			if (!best || exits > best.exits) best = { d, exits };
		}
		if (best) {
			bot.dir = best.d;
			return;
		}
	}
	// already stranded — keep heading and accept fate
}

// ---- hud ----

function nameHtml(p) {
	return `<span style="color:${p.color}">${p.name}</span>`;
}

function feed(html) {
	const div = document.createElement("div");
	div.className = "feed-line";
	div.innerHTML = html;
	feedEl.appendChild(div);
	while (feedEl.children.length > MAX_FEED) feedEl.removeChild(feedEl.firstChild);
}

function updateHUD() {
	const sorted = [...players].sort((a, b) => counts[b.id] - counts[a.id]);
	const total = GRID * GRID;
	standingsEl.innerHTML = sorted
		.map((p) => {
			const pct = (counts[p.id] / total) * 100;
			const filled = Math.round(Math.min(pct / (WIN_PCT * 100), 1) * BAR_WIDTH);
			const dagger = p.alive ? "" : `<span class="kills">&dagger;</span>`;
			return `<div class="standing${p.alive ? "" : " dead"}">
				<div class="row1">
					<span class="chip" style="background:${p.color}"></span>
					<span class="pname" style="color:${p.color}">${p.name}</span>
					${dagger}
					<span class="pct">${pct.toFixed(1)}%</span>
					<span class="kills">k:${p.kills}</span>
				</div>
				<span class="bar"><span style="color:${p.color}">${"\u2588".repeat(filled)}</span><span class="off">${"\u2591".repeat(BAR_WIDTH - filled)}</span></span>
			</div>`;
		})
		.join("");
}

// ---- overlays ----

function showOverlay(html) {
	overlayEl.innerHTML = html;
	overlayEl.classList.add("show");
}

function hideOverlay() {
	overlayEl.classList.remove("show");
}

function showStart() {
	showOverlay(`
		<div class="ov-inner">
			<p class="ov-title">paper<span class="cursor">_</span></p>
			<p class="ov-line">loop out, close the loop, take the land</p>
			<p class="ov-line dim">cross a trail to cut its owner &middot; loops claim everything they enclose &middot; territory split off from the rest crumbles &middot; first to ${Math.round(WIN_PCT * 100)}% wins</p>
			<p class="ov-go">press any key or tap to start</p>
		</div>
	`);
}

// ---- game flow ----

function startGame() {
	hideOverlay();
	initWorld();
	state = "run";
	paused = false;
	acc = 0;
	lastTime = performance.now();
	startTime = Date.now();
	feed("game started — good luck");
}

function togglePause() {
	if (state !== "run") return;
	paused = !paused;
	if (paused) {
		showOverlay(`
			<div class="ov-inner">
				<p class="ov-title">paused<span class="cursor">_</span></p>
				<p class="ov-go">press P or tap to resume</p>
			</div>
		`);
	} else {
		hideOverlay();
	}
}

const KEY_DIRS = {
	arrowup: 0,
	w: 0,
	arrowright: 1,
	d: 1,
	arrowdown: 2,
	s: 2,
	arrowleft: 3,
	a: 3,
};

// ---- input ----

function queueDir(d) {
	const you = players[0];
	if (!you.alive) return;
	const last = you.queue.length ? you.queue[you.queue.length - 1] : you.dir;
	if (d === last || d === (last + 2) % 4) return;
	if (you.queue.length < 3) you.queue.push(d);
}

window.addEventListener("keydown", (e) => {
	const k = e.key.toLowerCase();
	if (k.startsWith("arrow") || k === " ") e.preventDefault();
	if (state === "ready") {
		startGame();
		if (KEY_DIRS[k] !== undefined) queueDir(KEY_DIRS[k]);
		return;
	}
	if (state === "over") {
		if (k === "r" || k === "enter" || k === " ") startGame();
		return;
	}
	if (k === "p") {
		togglePause();
		return;
	}
	if (k === "r") {
		startGame();
		return;
	}
	if (!paused) {
		const d = KEY_DIRS[k];
		if (d !== undefined) queueDir(d);
	}
});

overlayEl.addEventListener("click", () => {
	if (state === "ready" || state === "over") startGame();
	else if (paused) togglePause();
});

let touchStart = null;
canvasEl.addEventListener("touchstart", (e) => {
	e.preventDefault();
	touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: false });

canvasEl.addEventListener("touchend", (e) => {
	e.preventDefault();
	if (!touchStart) return;
	const t = e.changedTouches[0];
	const dx = t.clientX - touchStart.x;
	const dy = t.clientY - touchStart.y;
	touchStart = null;
	if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) {
		if (state === "ready" || state === "over") startGame();
		return;
	}
	if (state !== "run" || paused) return;
	queueDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
}, { passive: false });

// ---- render ----

// size the canvas to its container (device pixels per visible cell)
function layout() {
	const wrap = canvasEl.parentElement;
	const size = wrap.clientWidth;
	if (!size) return;
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	const cell = Math.max(4, Math.floor((size * dpr) / VIEW));
	const device = cell * VIEW;
	if (canvasEl.width !== device) {
		CPX = cell;
		canvasEl.width = device;
		canvasEl.height = device;
		canvasEl.style.width = device / dpr + "px";
		canvasEl.style.height = device / dpr + "px";
	}
	if (minimapEl.width !== GRID) {
		minimapEl.width = GRID;
		minimapEl.height = GRID;
	}
	if (mapCan.width !== GRID) {
		mapCan.width = GRID;
		mapCan.height = GRID;
		dirtyTerritory = true;
	}
}

// full-map territory cache for the minimap
function drawMinimapCache() {
	mapCtx.fillStyle = "#060402";
	mapCtx.fillRect(0, 0, GRID, GRID);
	for (let y = 0; y < GRID; y++) {
		for (let x = 0; x < GRID; x++) {
			const o = owner[y * GRID + x];
			if (o < 0) continue;
			mapCtx.fillStyle = players[o].dim;
			mapCtx.fillRect(x, y, 1, 1);
		}
	}
}

function render(now) {
	if (dirtyTerritory) {
		drawMinimapCache();
		dirtyTerritory = false;
	}

	const you = players[0];
	const t = Math.min(acc / TICK_MS, 1);
	const fx = you.px + (you.x - you.px) * t + 0.5;
	const fy = you.py + (you.y - you.py) * t + 0.5;
	const targetX = Math.max(0, Math.min(GRID - VIEW, fx - VIEW / 2));
	const targetY = Math.max(0, Math.min(GRID - VIEW, fy - VIEW / 2));
	if (camX < 0) {
		camX = targetX;
		camY = targetY;
	} else {
		camX += (targetX - camX) * CAM_LERP;
		camY += (targetY - camY) * CAM_LERP;
	}

	const ox = -camX * CPX;
	const oy = -camY * CPX;
	const x0 = Math.max(0, Math.floor(camX));
	const y0 = Math.max(0, Math.floor(camY));
	const x1 = Math.min(GRID, Math.ceil(camX + VIEW) + 1);
	const y1 = Math.min(GRID, Math.ceil(camY + VIEW) + 1);

	ctx.fillStyle = "#060402";
	ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

	// territory
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const o = owner[y * GRID + x];
			if (o < 0) continue;
			ctx.fillStyle = players[o].dim;
			ctx.fillRect(Math.round(ox + x * CPX), Math.round(oy + y * CPX), CPX, CPX);
		}
	}

	// grid lines
	ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
	ctx.lineWidth = 1;
	ctx.beginPath();
	for (let x = x0; x <= x1; x++) {
		const px = Math.round(ox + x * CPX) + 0.5;
		ctx.moveTo(px, Math.max(0, Math.round(oy + y0 * CPX)));
		ctx.lineTo(px, Math.min(canvasEl.height, Math.round(oy + y1 * CPX)));
	}
	for (let y = y0; y <= y1; y++) {
		const py = Math.round(oy + y * CPX) + 0.5;
		ctx.moveTo(Math.max(0, Math.round(ox + x0 * CPX)), py);
		ctx.lineTo(Math.min(canvasEl.width, Math.round(ox + x1 * CPX)), py);
	}
	ctx.stroke();

	const onScreen = (ci) => {
		const cx = ci % GRID;
		const cy = (ci / GRID) | 0;
		return cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
	};

	// trails
	for (const p of players) {
		if (!p.alive || !p.trailCells.length) continue;
		ctx.fillStyle = p.color;
		for (const ci of p.trailCells) {
			if (!onScreen(ci)) continue;
			const x = ci % GRID;
			const y = (ci / GRID) | 0;
			ctx.fillRect(Math.round(ox + x * CPX) + CPX / 6, Math.round(oy + y * CPX) + CPX / 6, (CPX * 2) / 3, (CPX * 2) / 3);
		}
	}

	// capture flashes
	for (let i = flashes.length - 1; i >= 0; i--) {
		const f = flashes[i];
		const age = now - f.t0;
		if (age > FLASH_MS) {
			flashes.splice(i, 1);
			continue;
		}
		ctx.globalAlpha = 0.55 * (1 - age / FLASH_MS);
		ctx.fillStyle = f.color;
		for (const ci of f.cells) {
			if (!onScreen(ci)) continue;
			const x = ci % GRID;
			const y = (ci / GRID) | 0;
			ctx.fillRect(Math.round(ox + x * CPX), Math.round(oy + y * CPX), CPX, CPX);
		}
		ctx.globalAlpha = 1;
	}

	// heads
	for (const p of players) {
		if (!p.alive) continue;
		const hx = (p.px + (p.x - p.px) * t) * CPX + ox;
		const hy = (p.py + (p.y - p.py) * t) * CPX + oy;
		if (hx < -CPX * 2 || hy < -CPX * 2 || hx > canvasEl.width + CPX * 2 || hy > canvasEl.height + CPX * 2) continue;
		ctx.fillStyle = p.head;
		ctx.fillRect(Math.round(hx), Math.round(hy), CPX, CPX);
		ctx.strokeStyle = "#000000";
		ctx.lineWidth = Math.max(1, CPX / 8);
		ctx.strokeRect(
			Math.round(hx) + ctx.lineWidth / 2,
			Math.round(hy) + ctx.lineWidth / 2,
			CPX - ctx.lineWidth,
			CPX - ctx.lineWidth
		);
	}

	// minimap: territory + heads + viewport box
	minimapCtx.imageSmoothingEnabled = false;
	minimapCtx.drawImage(mapCan, 0, 0);
	for (const p of players) {
		if (!p.alive) continue;
		minimapCtx.fillStyle = p.color;
		minimapCtx.fillRect(p.x - 1, p.y - 1, 3, 3);
	}
	minimapCtx.strokeStyle = "rgba(255, 174, 66, 0.7)";
	minimapCtx.lineWidth = 1;
	minimapCtx.strokeRect(camX + 0.5, camY + 0.5, VIEW - 1, VIEW - 1);
}

// ---- main loop ----

function frame(now) {
	requestAnimationFrame(frame);
	if (state === "run" && !paused) {
		acc += Math.min(now - lastTime, 250);
		lastTime = now;
		let steps = 0;
		while (acc >= TICK_MS && steps < 5 && state === "run") {
			tick();
			acc -= TICK_MS;
			steps++;
		}
	} else {
		lastTime = now;
	}
	render(now);
}

// ---- boot ----

layout();
initWorld();
showStart();
requestAnimationFrame(frame);
