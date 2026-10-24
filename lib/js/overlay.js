/*
 * Stream overlay: poll, tick, render.
 *
 * Same endpoint and the same penalty and clock rules as the live page, kept
 * in its own file because live.js is tied to that page's markup. The only
 * client is the OBS machine, so it polls every second rather than every five:
 * the score on the stream should change when the scorekeeper taps, not up to
 * five seconds later.
 *
 * A failed poll is never shown. Anything on screen goes out to every viewer,
 * so the overlay keeps the last good state and retries quietly.
 */
(function () {
	'use strict';

	var POLL_MS     = 1000;
	var MAX_BACKOFF = 10000;
	var REQ_TIMEOUT = 5000;
	var GOAL_MS     = 8000;  // how long the GOAL banner stays up

	var state       = window.RH_LIVE_BOOTSTRAP || null;
	var lastUpdated = (state && state.updated) || null;
	var clockBase   = state ? { gameSec: state.game_sec, at: Date.now() } : null;
	var backoff     = POLL_MS;
	var timer       = null;
	var goalTimer   = null;

	var el = {
		ov:        document.getElementById('ov'),
		rice:      document.getElementById('ov-rice'),
		opp:       document.getElementById('ov-opp'),
		oppName:   document.getElementById('ov-opp-name'),
		oppLogo:   document.getElementById('ov-opp-logo'),
		period:    document.getElementById('ov-period'),
		clock:     document.getElementById('ov-clock'),
		strip:     document.getElementById('ov-strip'),
		stripText: document.getElementById('ov-strip-text'),
		stripTime: document.getElementById('ov-strip-clock'),
		goal:      document.getElementById('ov-goal')
	};

	function pad(n) { return (n < 10 ? '0' : '') + n; }
	function mmss(sec) { return Math.floor(sec / 60) + ':' + pad(sec % 60); }

	/* Counts down within the period like the rink clock, matching the live
	 * page. */
	function formatClock(gameSec, periodLength) {
		var into = gameSec % periodLength;
		if (gameSec > 0 && into === 0) { into = periodLength; }
		var left = periodLength - into;
		return pad(Math.floor(left / 60)) + ':' + pad(left % 60);
	}

	function ordinal(p) { return p + (['th', 'st', 'nd', 'rd'][p] || 'th'); }

	function teamName(team) { return team === 'rice' ? 'Rice' : state.opponent; }

	function nowSec() {
		if (!state || state.status !== 'live' || !state.clock_running || !clockBase) {
			return (state && state.game_sec) || 0;
		}
		var elapsed = Math.floor((Date.now() - clockBase.at) / 1000);
		return Math.min(clockBase.gameSec + elapsed, state.period * state.period_length);
	}

	/* ------------------------------------------------------------ render -- */

	function render() {
		if (!state || state.status === 'none') {
			el.ov.hidden = true;
			return;
		}
		el.ov.hidden = false;
		el.rice.textContent    = state.score.rice;
		el.opp.textContent     = state.score.opp;
		el.oppName.textContent = state.opponent;
		// Admin-chosen opponent colour, with a text colour picked to read on it.
		var root = document.documentElement.style;
		if (state.opponent_color) {
			root.setProperty('--ov-opp', state.opponent_color);
			root.setProperty('--ov-opp-ink', state.opponent_ink);
		} else {
			root.removeProperty('--ov-opp');
			root.removeProperty('--ov-opp-ink');
		}
		if (state.opponent_logo) {
			el.oppLogo.src = state.opponent_logo;
			el.oppLogo.hidden = false;
		} else {
			el.oppLogo.hidden = true;
		}
		tick();
	}

	function tick() {
		if (!state || state.status === 'none') { return; }
		var now = nowSec();

		if (state.status === 'scheduled') {
			el.period.textContent = 'Pregame';
			el.clock.hidden = true;
		} else if (state.status === 'final') {
			el.period.textContent = 'Final';
			el.clock.hidden = true;
		} else if (now >= state.period * state.period_length) {
			el.period.textContent = 'End ' + ordinal(state.period);
			el.clock.hidden = true;
		} else {
			el.period.textContent = ordinal(state.period);
			el.clock.textContent  = formatClock(now, state.period_length);
			el.clock.hidden = false;
		}

		renderStrip(now);
	}

	/* Strength and the time until it next changes, from the penalties still
	 * running. Misconducts are replaced on the ice, so they never count. */
	function renderStrip(now) {
		var off  = { rice: 0, opp: 0 };
		var next = { rice: Infinity, opp: Infinity };

		if (state.status === 'live') {
			(state.penalties || []).forEach(function (p) {
				var left = p.end_sec - now;
				if (left <= 0 || p.minutes === 10) { return; }
				off[p.team]++;
				next[p.team] = Math.min(next[p.team], left);
			});
		}

		var r = 5 - Math.min(2, off.rice);
		var o = 5 - Math.min(2, off.opp);

		// The GOAL banner sits where the strip does and wins while it is up.
		if ((r === 5 && o === 5) || !el.goal.hidden) {
			el.strip.hidden = true;
			return;
		}
		var left;
		if (r === o) {
			el.stripText.textContent = r + ' on ' + o;
			left = Math.min(next.rice, next.opp);
		} else {
			var adv = r > o ? 'rice' : 'opp';
			el.stripText.textContent = 'Power play · ' + teamName(adv) +
				(Math.abs(r - o) > 1 ? ' · 5 on 3' : '');
			left = next[adv === 'rice' ? 'opp' : 'rice'];
		}
		el.stripTime.textContent = mmss(left);
		el.strip.hidden = false;
	}

	/* Only on a score going up during play: an undo lowers it, and loading
	 * the overlay mid-game must not replay old goals. */
	function announceGoals(prev, next) {
		if (!prev || !prev.score || next.status !== 'live') { return; }
		var team = next.score.rice > prev.score.rice ? 'rice'
			: next.score.opp > prev.score.opp ? 'opp' : null;
		if (!team) { return; }
		el.goal.textContent = 'Goal · ' + teamName(team);
		el.goal.className = 'ov-goal is-' + team;
		el.goal.hidden = false;
		clearTimeout(goalTimer);
		goalTimer = setTimeout(function () { el.goal.hidden = true; tick(); }, GOAL_MS);
	}

	/* -------------------------------------------------------------- poll -- */

	function poll() {
		var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
		var killer = ctl ? setTimeout(function () { ctl.abort(); }, REQ_TIMEOUT) : null;

		fetch('/score.php', {
			headers: { 'Accept': 'application/json' },
			cache: 'no-cache',
			signal: ctl ? ctl.signal : undefined
		})
			.then(function (res) {
				if (res.status === 304) { return null; }
				if (res.status === 503) { return { status: 'none' }; }
				if (!res.ok) { throw new Error('http ' + res.status); }
				return res.json();
			})
			.then(function (data) {
				clearTimeout(killer);
				backoff = POLL_MS;
				if (data && data.updated !== lastUpdated) {
					lastUpdated = data.updated;
					announceGoals(state, data);
					state = data;
					clockBase = { gameSec: data.game_sec, at: Date.now() };
					render();
				}
				schedule(POLL_MS);
			})
			.catch(function () {
				clearTimeout(killer);
				backoff = Math.min(backoff * 2, MAX_BACKOFF);
				schedule(backoff);
			});
	}

	function schedule(ms) {
		clearTimeout(timer);
		timer = setTimeout(poll, ms);
	}

	render();
	setInterval(tick, 250);
	schedule(POLL_MS);
})();
