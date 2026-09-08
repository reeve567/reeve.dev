// boggle — a daily word hunt.
// the board is rolled from the date, so everyone playing the same
// day sees the same letters. chain adjacent dice into words — longer
// chains score more. find par to win the day, keep the streak alive.
// scores and streaks live in localStorage, one record per day.

const SIZE = 4;
const CELLS = SIZE * SIZE;
const MIN_WORD = 4; // letters (the qu die counts as two)
const TIME_MS = 3 * 60 * 1000;
const BOARD_ATTEMPTS = 8; // rolls per day, richest wins — no stinker dailies
const PAR_FACTOR = 0.15;
const PAR_MIN = 8;

// the classic boggle dice, one face per roll
const DICE = [
	["a", "a", "e", "e", "g", "n"],
	["e", "l", "r", "t", "t", "y"],
	["a", "o", "o", "t", "t", "w"],
	["a", "b", "b", "j", "o", "o"],
	["e", "h", "r", "t", "v", "w"],
	["c", "i", "m", "o", "t", "u"],
	["d", "i", "s", "t", "t", "y"],
	["e", "i", "o", "s", "s", "t"],
	["d", "e", "l", "r", "v", "x"],
	["a", "c", "h", "o", "p", "s"],
	["h", "i", "m", "n", "qu", "u"],
	["e", "e", "i", "n", "s", "u"],
	["e", "e", "g", "h", "n", "w"],
	["a", "f", "f", "k", "p", "s"],
	["h", "l", "n", "n", "r", "z"],
	["d", "e", "i", "l", "r", "x"],
];

const POINTS = { 4: 1, 5: 2, 6: 3, 7: 5 };

function wordPoints(word) {
	return POINTS[word.length] ?? 11;
}

// the word list, fetched once at boot
const DICT = new Set();

// ---- seeded boards ----

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// roll one board from a seed — shuffle the dice, roll each die
function rollBoard(rng) {
	const order = DICE.map((_, i) => i);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return order.map((di) => DICE[di][Math.floor(rng() * 6)]);
}

// the day's board: several rolls seeded from the date, richest word
// count wins. the classic dice throw stinker boards regularly (one
// e in sixteen letters is a real outcome) — picking the best of a
// few rolls keeps every day workable while staying deterministic,
// so everyone still gets the same board
function boardForDate(dateStr) {
	const base = Number(dateStr.replaceAll("-", "")) || 1;
	let best = null;
	let bestCount = -1;
	for (let attempt = 0; attempt < BOARD_ATTEMPTS; attempt++) {
		const faces = rollBoard(mulberry32(base + attempt * 7919));
		const count = solveBoard(faces).size;
		if (count > bestCount) {
			bestCount = count;
			best = faces;
		}
	}
	return best;
}

// adjacency of row-major 4x4 cells, including diagonals
const ADJ = [];
for (let i = 0; i < CELLS; i++) {
	const x = i % SIZE;
	const y = (i / SIZE) | 0;
	const list = [];
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			if (!dx && !dy) continue;
			const nx = x + dx;
			const ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
			list.push(ny * SIZE + nx);
		}
	}
	ADJ.push(list);
}

// every word this board can spell — dictionary pruned to its letters,
// then a prefix-pruned dfs over all paths. the candidate and prefix
// sets stay in module state so deadness tracking can reuse them
let solverCandidates = new Set();
let solverPrefixes = new Set();
let deadDice = new Uint8Array(CELLS); // 1 = no unfound word can use this die

function solveBoard(faces) {
	const have = {};
	let letters = 0;
	for (const face of faces) {
		for (const ch of face) have[ch] = (have[ch] || 0) + 1;
		letters += face.length;
	}
	solverCandidates = new Set();
	for (const word of DICT) {
		if (word.length < MIN_WORD || word.length > letters) continue;
		const need = {};
		let ok = true;
		for (const ch of word) {
			need[ch] = (need[ch] || 0) + 1;
			if (need[ch] > (have[ch] || 0)) {
				ok = false;
				break;
			}
		}
		if (ok) solverCandidates.add(word);
	}
	solverPrefixes = new Set();
	for (const word of solverCandidates) {
		for (let i = 1; i <= word.length; i++) solverPrefixes.add(word.slice(0, i));
	}
	const found = new Set();
	const dfs = (ci, str, used) => {
		const next = str + faces[ci];
		if (!solverPrefixes.has(next)) return;
		if (next.length >= MIN_WORD && solverCandidates.has(next)) found.add(next);
		for (const ni of ADJ[ci]) {
			if (!(used & (1 << ni))) dfs(ni, next, used | (1 << ni));
		}
	};
	for (let i = 0; i < CELLS; i++) dfs(i, "", 1 << i);
	return found;
}

// gray out dice that no longer matter: a die is dead when no unfound
// word can be spelled through it. runs the same prefix-pruned dfs,
// marking the path of every word completion that's still wanted.
// deadness is input state, not just a dim visual — spent dice refuse
// to join words via drag, tap, or typing
function updateDeadDice() {
	const alive = new Uint8Array(CELLS);
	const dfs = (ci, str, used, path) => {
		const next = str + faces[ci];
		if (!solverPrefixes.has(next)) return;
		path.push(ci);
		if (next.length >= MIN_WORD && solverCandidates.has(next) && !found.has(next)) {
			for (const cell of path) alive[cell] = 1;
		}
		for (const ni of ADJ[ci]) {
			if (!(used & (1 << ni))) dfs(ni, next, used | (1 << ni), path);
		}
		path.pop();
	};
	for (let i = 0; i < CELLS; i++) dfs(i, "", 1 << i, []);
	for (let i = 0; i < CELLS; i++) deadDice[i] = alive[i] ? 0 : 1;
	const dies = dieEls();
	for (let i = 0; i < dies.length; i++) {
		dies[i].classList.toggle("dead", !!deadDice[i]);
	}
}

// ---- records: one per day, in localStorage ----

function fmtDate(d) {
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function todayStr() {
	return fmtDate(new Date());
}

function loadRecord(dateStr) {
	try {
		return JSON.parse(localStorage.getItem("boggle:" + dateStr));
	} catch (e) {
		return null;
	}
}

function saveRecord(dateStr, rec) {
	localStorage.setItem("boggle:" + dateStr, JSON.stringify(rec));
}

function loadStats() {
	const byDay = new Map();
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (!key.startsWith("boggle:")) continue;
		try {
			byDay.set(key.slice(7), JSON.parse(localStorage.getItem(key)));
		} catch (e) {
			/* ignore malformed days */
		}
	}
	const stats = { played: 0, wins: 0, best: 0, streak: 0 };
	for (const rec of byDay.values()) {
		stats.played++;
		if (rec && rec.won) stats.wins++;
		if (rec && rec.score > stats.best) stats.best = rec.score;
	}
	const wonOn = (ds) => byDay.has(ds) && byDay.get(ds).won;
	const d = new Date();
	if (!wonOn(todayStr())) d.setDate(d.getDate() - 1);
	while (wonOn(fmtDate(d))) {
		stats.streak++;
		d.setDate(d.getDate() - 1);
	}
	return stats;
}

// ---- dom ----

const boardEl = document.getElementById("board");
const guessEl = document.getElementById("guess");
const hintEl = document.getElementById("hint");
const wordsEl = document.getElementById("words");
const dayStatsEl = document.getElementById("daystats");
const allStatsEl = document.getElementById("allstats");
const dateLabelEl = document.getElementById("date-label");
const prevBtn = document.getElementById("prev-day");
const nextBtn = document.getElementById("next-day");
const backBtn = document.getElementById("key-back");
const enterBtn = document.getElementById("key-enter");
const overlayEl = document.getElementById("overlay");

// ---- state ----

let date = todayStr();
let faces = [];
let allWords = new Set();
let par = PAR_MIN;
let found = new Set();
let score = 0;
let guess = "";
let sel = []; // die indexes of the current path
let longest = "";
let state = "loading"; // loading | ready | run | over
let practice = false; // record for today already exists
let deadline = 0;
let timerId = 0;

// ---- board setup ----

function initDay(dayStr) {
	date = dayStr;
	faces = boardForDate(date);
	allWords = solveBoard(faces);
	par = Math.max(PAR_MIN, Math.round(allWords.size * PAR_FACTOR));
	found = new Set();
	score = 0;
	guess = "";
	sel = [];
	longest = "";
	const record = loadRecord(date);
	practice = !!record;
	state = "ready";
	stopTimer();
	renderBoard();
	renderWords();
	paintSelection();
	updateDeadDice();
	updateStats();
	showStartOverlay(record);
}

function renderBoard() {
	boardEl.innerHTML = "";
	for (let i = 0; i < CELLS; i++) {
		const die = document.createElement("button");
		die.className = "die" + (faces[i].length > 1 ? " wide" : "");
		die.textContent = faces[i];
		die.addEventListener("click", () => dieClick(i));
		boardEl.appendChild(die);
	}
}

function dieEls() {
	return boardEl.children;
}

// ---- input ----

function dieClick(i) {
	if (state === "ready") startRun();
	if (state !== "run") return;
	if (deadDice[i]) return; // spent dice don't join words
	const last = sel[sel.length - 1];
	if (i === last) {
		sel.pop();
	} else if (last !== undefined && !sel.includes(i) && ADJ[last].includes(i)) {
		sel.push(i);
	} else if (!sel.includes(i)) {
		sel = [i];
	} else {
		return; // re-tapping a used die does nothing
	}
	guess = sel.map((ci) => faces[ci]).join("");
	paintSelection();
}

// touch dragging: press a die, slide through adjacent letters, lift to
// submit. sliding back along the path undoes a step; a plain tap (no
// slide) falls back to the tap-to-build behavior. gets doubly
// forgiving: fingers are imprecise — hovering a die uses grid math
// over gaps, and moving away from the current die snaps to whichever
// of its 8 neighbors best matches the drag direction, so diagonals
// work by cutting through die corners
let touchDrag = null;

// which die is under a screen point — grid math, no dom walking
function dieFromPoint(x, y) {
	const rect = boardEl.getBoundingClientRect();
	const col = Math.floor((x - rect.left) / (rect.width / SIZE));
	const row = Math.floor((y - rect.top) / (rect.height / SIZE));
	if (col < 0 || col >= SIZE || row < 0 || row >= SIZE) return -1;
	return row * SIZE + col;
}

// the 8 drag directions, 45° apart, starting east
const DRAG_DIRS = [
	[1, 0],
	[1, 1],
	[0, 1],
	[-1, 1],
	[-1, 0],
	[-1, -1],
	[0, -1],
	[1, -1],
];

// extend (or backtrack) the path by intent: if the finger has left
// the current die's zone, snap its direction to the nearest diagonal
// or orthogonal neighbor and take it. repeats a few times per move
// event so fast swipes don't skip dice. backtrack needs hysteresis —
// the finger must travel nearly to the previous die's center to pop,
// otherwise a finger parked between two cells oscillates uselessly
function dragByIntent(x, y) {
	const rect = boardEl.getBoundingClientRect();
	const pitch = rect.width / SIZE;
	const pushZone = pitch * 0.55;
	const popZone = pitch * 0.95;
	for (let hop = 0; hop < 4; hop++) {
		const last = sel[sel.length - 1];
		if (last === undefined) return;
		const col = last % SIZE;
		const row = (last / SIZE) | 0;
		const cx = rect.left + (col + 0.5) * pitch;
		const cy = rect.top + (row + 0.5) * pitch;
		const dx = x - cx;
		const dy = y - cy;
		const dist = Math.hypot(dx, dy);
		if (dist < pushZone) return; // still inside the die's zone
		const oct = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
		const nCol = col + DRAG_DIRS[oct][0];
		const nRow = row + DRAG_DIRS[oct][1];
		if (nCol < 0 || nCol >= SIZE || nRow < 0 || nRow >= SIZE) return;
		const ni = nRow * SIZE + nCol;
		if (sel.length > 1 && ni === sel[sel.length - 2]) {
			if (dist < popZone) return; // barely left the die — not a real backtrack
			sel.pop(); // dragged back along the path
			touchDrag.moved = true;
		} else if (!sel.includes(ni) && !deadDice[ni]) {
			sel.push(ni);
			touchDrag.moved = true;
		} else {
			return;
		}
	}
}

boardEl.addEventListener("touchstart", (e) => {
	if (state !== "ready" && state !== "run") return;
	e.preventDefault();
	if (touchDrag) return; // one finger at a time
	const i = dieFromPoint(e.touches[0].clientX, e.touches[0].clientY);
	if (i === -1) return;
	if (state === "ready") startRun();
	touchDrag = { start: i, preSel: sel.slice(), preGuess: guess, moved: false };
	if (deadDice[i]) {
		sel = []; // a spent die can't begin a word — the drag stays claimed
		guess = "";
		paintSelection();
		return;
	}
	sel = [i];
	guess = faces[i];
	paintSelection();
}, { passive: false });

boardEl.addEventListener("touchmove", (e) => {
	if (!touchDrag) return;
	e.preventDefault();
	const x = e.touches[0].clientX;
	const y = e.touches[0].clientY;
	const i = dieFromPoint(x, y);
	const last = sel[sel.length - 1];
	// direct hover on a fresh die handles its own selection semantics
	if (i !== -1 && i !== last) {
		let acted = false;
		if (last !== undefined && sel.length > 1 && i === sel[sel.length - 2]) {
			sel.pop(); // slid back onto the previous die
			touchDrag.moved = true;
			acted = true;
		} else if (last !== undefined && ADJ[last].includes(i) && !sel.includes(i) && !deadDice[i]) {
			sel.push(i);
			touchDrag.moved = true;
			acted = true;
		}
		if (acted) {
			guess = sel.map((ci) => faces[ci]).join("");
			paintSelection();
			return;
		}
	}
	// otherwise move by drag direction — corner-cutting diagonals,
	// gaps, and off-board fingers all still drive the path
	dragByIntent(x, y);
	guess = sel.map((ci) => faces[ci]).join("");
	paintSelection();
}, { passive: false });

boardEl.addEventListener("touchend", (e) => {
	if (!touchDrag) return;
	if (e.cancelable) e.preventDefault();
	if (touchDrag.moved && sel.length >= 2) {
		submitGuess(); // a real drag — release submits the word
	} else {
		// a plain tap — put the selection back and re-run tap behavior
		// on the die the gesture began on
		sel = touchDrag.preSel;
		guess = touchDrag.preGuess;
		dieClick(touchDrag.start);
	}
	touchDrag = null;
}, { passive: false });

boardEl.addEventListener("touchcancel", () => {
	if (!touchDrag) return;
	sel = touchDrag.preSel; // an aborted drag changes nothing
	guess = touchDrag.preGuess;
	touchDrag = null;
	paintSelection();
}, { passive: false });

function addLetter(ch) {
	if (state === "ready") startRun();
	if (state !== "run") return;
	guess += ch === "q" ? "qu" : ch; // pressing q grabs the qu die
	resyncPath();
	paintSelection();
}

function popLetter() {
	if (state !== "run" || !guess) return;
	guess = guess.slice(0, guess.length - 1);
	resyncPath();
	paintSelection();
}

// any path spelling the current guess — keeps typing and tapping in
// sync. dead dice never route: any unfound word has a live path, so
// this only fails for junk or already-found words
function matchWord(str) {
	if (!str) return null;
	let result = null;
	const dfs = (ci, pos, used, path) => {
		if (result) return;
		const face = faces[ci];
		if (!str.startsWith(face, pos)) return;
		const nextUsed = used | (1 << ci);
		const nextPos = pos + face.length;
		path.push(ci);
		if (nextPos === str.length) {
			result = path.slice();
			return;
		}
		for (const ni of ADJ[ci]) {
			if (nextUsed & (1 << ni)) continue;
			if (deadDice[ni]) continue;
			dfs(ni, nextPos, nextUsed, path);
		}
		path.pop();
	};
	for (let i = 0; i < CELLS && !result; i++) {
		if (!deadDice[i]) dfs(i, 0, 0, []);
	}
	return result;
}

function resyncPath() {
	sel = matchWord(guess) || [];
}

function submitGuess() {
	if (state !== "run" || !guess) return;
	if (guess.length < MIN_WORD) hint("too short", "bad");
	else if (!allWords.has(guess)) hint("not a word", "bad");
	else if (found.has(guess)) hint("already got that one", "bad");
	else {
		const pts = wordPoints(guess);
		found.add(guess);
		score += pts;
		if (guess.length > longest.length) longest = guess;
		hint("+" + pts + " " + guess, "good");
		updateDeadDice();
	}
	guess = "";
	sel = [];
	paintSelection();
	renderWords();
	updateStats();
}

// ---- run flow ----

function startRun() {
	if (state !== "ready") return;
	state = "run";
	hideOverlay();
	deadline = Date.now() + TIME_MS;
	timerId = setInterval(tick, 250);
	tick();
}

function stopTimer() {
	clearInterval(timerId);
	timerId = 0;
}

function tick() {
	const left = deadline - Date.now();
	if (left <= 0) {
		endRun();
		return;
	}
	updateStats();
}

function endRun() {
	if (state !== "run") return;
	state = "over";
	stopTimer();
	const won = found.size >= par;
	if (!practice) {
		saveRecord(date, { score, words: found.size, longest, won });
	}
	updateDeadDice();
	renderWords(true);
	updateStats();
	showEndOverlay(won);
}

// ---- painting ----

function paintSelection() {
	const dies = dieEls();
	for (let i = 0; i < dies.length; i++) {
		dies[i].classList.remove("path", "last");
	}
	sel.forEach((ci, n) => {
		dies[ci].classList.add("path");
		if (n === sel.length - 1) dies[ci].classList.add("last");
	});
	guessEl.textContent = guess;
	const ok = !guess || matchWord(guess);
	guessEl.classList.toggle("bad", !ok);
}

function renderWords(withMissed) {
	wordsEl.innerHTML = "";
	const addChip = (word, cls) => {
		const chip = document.createElement("span");
		chip.className = "word-chip" + (cls ? " " + cls : "");
		chip.textContent = word;
		wordsEl.appendChild(chip);
	};
	for (const word of found) addChip(word);
	if (withMissed) {
		const missed = [...allWords].filter((w) => !found.has(w)).sort((a, b) => b.length - a.length || a.localeCompare(b));
		if (missed.length) {
			const label = document.createElement("p");
			label.className = "missed-label";
			label.textContent = "missed (" + missed.length + ")";
			wordsEl.appendChild(label);
			for (const word of missed) addChip(word, "missed");
		}
	}
}

function updateStats() {
	const left = state === "run" ? Math.max(0, deadline - Date.now()) : state === "over" ? 0 : TIME_MS;
	const secs = Math.ceil(left / 1000);
	const clock = Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
	const record = loadRecord(date);
	let html = `<span class="b-score">${score}</span> pts &middot; ${found.size}/${allWords.size || "?"} words`
		+ `<span class="b-clock${secs <= 30 && state === "run" ? " low" : ""}">${clock}</span>`
		+ `<br />par: ${par} words`
		+ (record ? `<br />record: ${record.score} pts &middot; practice` : "");
	dayStatsEl.innerHTML = html;
	const s = loadStats();
	allStatsEl.innerHTML = `streak: ${s.streak} &middot; wins: ${s.wins}/${s.played}` + (s.best ? `<br />best: ${s.best} pts` : "");
	dateLabelEl.textContent = new Date(date + "T00:00:00").toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
	nextBtn.disabled = date >= todayStr();
}

function hint(text, cls) {
	hintEl.textContent = text;
	hintEl.className = "guess-hint" + (cls ? " " + cls : "");
	clearTimeout(hint.t);
	hint.t = setTimeout(() => {
		hintEl.textContent = "";
		hintEl.className = "guess-hint";
	}, 1600);
}

// ---- overlays ----

function showOverlay(html) {
	overlayEl.innerHTML = html;
	overlayEl.classList.add("show");
}

function hideOverlay() {
	overlayEl.classList.remove("show");
}

function showStartOverlay(record) {
	const note = record
		? `you scored ${record.score} pts here — this one's practice`
		: "find par to win the day and keep your streak";
	const quNote = faces.includes("qu") ? "the qu die spells q + u — just type q" : "";
	showOverlay(`
		<div class="ov-inner">
			<p class="ov-title">boggle<span class="cursor">_</span></p>
			<p class="ov-line">chain adjacent dice into words of ${MIN_WORD}+ letters</p>
			<p class="ov-line dim">${[note, quNote, "3:00 on the clock"].filter(Boolean).join(" &middot; ")}</p>
			<p class="ov-go">press any key or tap a die to start</p>
		</div>
	`);
}

function showEndOverlay(won) {
	const title = practice ? "practice over" : won ? "you win" : "you lose";
	const sub = practice
		? "practice runs don't touch your record"
		: won
			? `par ${par}, found ${found.size} — streak safe`
			: `you found ${found.size} of ${allWords.size} — par was ${par}`;
	showOverlay(`
		<div class="ov-inner">
			<p class="ov-title">${title}<span class="cursor">_</span></p>
			<p class="ov-line">${sub}</p>
			<p class="ov-stats">${score} pts &middot; longest: ${longest || "none"} &middot; ${hintShareable()}</p>
			<div class="ov-actions">
				<button class="b-btn" id="share-btn">copy result</button>
			</div>
			<p class="ov-go">press R or tap for a practice run</p>
		</div>
	`);
	const share = document.getElementById("share-btn");
	if (share) share.addEventListener("click", shareResult);
}

function hintShareable() {
	return `boggle ${date} · ${found.size}/${allWords.size} words · ${score} pts`;
}

function shareResult() {
	const text = `${hintShareable()} · par ${par}${practice ? " · practice" : ""}`;
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(
			() => hint("copied", "good"),
			() => hint(text)
		);
	} else {
		hint(text);
	}
}

// ---- date navigation ----

function shiftDay(delta) {
	const d = new Date(date + "T00:00:00");
	d.setDate(d.getDate() + delta);
	const ds = fmtDate(d);
	if (ds > todayStr()) return;
	guess = "";
	sel = [];
	initDay(ds);
}

prevBtn.addEventListener("click", () => shiftDay(-1));
nextBtn.addEventListener("click", () => shiftDay(1));
backBtn.addEventListener("click", popLetter);
enterBtn.addEventListener("click", submitGuess);
overlayEl.addEventListener("click", () => {
	if (state === "ready") startRun();
	else if (state === "over") initDay(date);
});

window.addEventListener("keydown", (e) => {
	const k = e.key.toLowerCase();
	if (k === " " || k === "enter" || k.startsWith("arrow")) e.preventDefault();
	if (state === "loading") return;
	if (state === "ready") {
		if (/^[a-z]$/.test(k)) addLetter(k);
		else startRun();
		return;
	}
	if (state === "over") {
		if (k === "r") initDay(date);
		return;
	}
	if (k === "arrowleft") {
		shiftDay(-1);
		return;
	}
	if (k === "arrowright") {
		shiftDay(1);
		return;
	}
	if (k === "enter") {
		submitGuess();
		return;
	}
	if (k === "backspace") {
		e.preventDefault();
		popLetter();
		return;
	}
	if (k === "escape") {
		guess = "";
		sel = [];
		paintSelection();
		return;
	}
	if (/^[a-z]$/.test(k)) addLetter(k);
});

// ---- boot ----

// words.js — loaded via a plain script tag before this file so the
// game runs from file:// as well as over http — carries the dictionary
let readyPromise;
try {
	if (typeof BOGGLE_WORDS !== "string" || !BOGGLE_WORDS) throw new Error("empty dictionary");
	for (const w of BOGGLE_WORDS.split("\n")) {
		const word = w.trim().toLowerCase();
		if (word) DICT.add(word);
	}
	initDay(todayStr());
	readyPromise = Promise.resolve();
} catch (err) {
	readyPromise = Promise.reject(err);
	showOverlay(`
		<div class="ov-inner">
			<p class="ov-title">no dictionary<span class="cursor">_</span></p>
			<p class="ov-line dim">${err}</p>
		</div>
	`);
}
