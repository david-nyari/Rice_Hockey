/*
 * Scorekeeper console enhancement.
 *
 * The page works without this file: every button is a real submit on a real
 * form, and the server redirects after a POST so a refresh cannot double-count
 * a goal. This upgrades a tap to a fetch so the page does not reload, and
 * guards the two irreversible-ish actions behind a confirm.
 */
(function () {
	'use strict';

	var pad = document.getElementById('pad');
	if (!pad) { return; }

	var busy = false;

	function setBusy(on) {
		busy = on;
		Array.prototype.forEach.call(pad.querySelectorAll('button'), function (b) {
			if (on) {
				if (!b.disabled) { b.dataset.rhReenable = '1'; b.disabled = true; }
			} else if (b.dataset.rhReenable) {
				b.disabled = false;
				delete b.dataset.rhReenable;
			}
		});
	}

	pad.addEventListener('submit', function (ev) {
		var btn = ev.submitter;
		if (!btn) { return; } // no submitter info: let the plain POST happen

		var confirmText = btn.getAttribute('data-confirm');
		if (confirmText && !window.confirm(confirmText)) {
			ev.preventDefault();
			return;
		}

		// A period change alters which buttons are enabled and what they say,
		// so let that one go through as a normal navigation.
		if (btn.value === 'period') { return; }

		ev.preventDefault();
		if (busy) { return; }
		setBusy(true);

		var body = new FormData(pad);
		body.set('action', btn.value);

		fetch('/admin.php', {
			method: 'POST',
			body: body,
			redirect: 'follow',
			credentials: 'same-origin'
		})
			.then(function (res) {
				if (!res.ok) { throw new Error('http ' + res.status); }
				return res.text();
			})
			.then(function (html) {
				// The POST redirects to a full render; lift the two numbers and
				// the penalty list out of it rather than reloading the whole
				// page. The list matters because a goal can release a penalty.
				var doc = new DOMParser().parseFromString(html, 'text/html');
				['n-rice', 'n-opp'].forEach(function (id) {
					var from = doc.getElementById(id);
					var to   = document.getElementById(id);
					if (from && to) { to.textContent = from.textContent; }
				});
				var pensFrom = doc.getElementById('pen-list');
				var pensTo   = document.getElementById('pen-list');
				if (pensFrom && pensTo) { pensTo.innerHTML = pensFrom.innerHTML; }
				var btnFrom = doc.getElementById('btn-clock');
				var btnTo   = document.getElementById('btn-clock');
				if (btnFrom && btnTo) {
					btnTo.textContent = btnFrom.textContent;
					btnTo.className   = btnFrom.className;
				}
				anchor(doc.querySelector('.admin-clock'));
				tick();
				if (navigator.vibrate) { navigator.vibrate(15); }
				setBusy(false);
			})
			.catch(function () {
				// Do not leave the operator guessing whether the goal landed.
				setBusy(false);
				window.alert('That tap did not reach the server. Check signal and try again.');
			});
	});

	/* Local clock, re-anchored from the server value on every render and
	 * after every tap. Held at the period's end, as the server's is, so it
	 * does not wrap to 00:00 during an intermission. Penalty countdowns run
	 * off the same value, so they freeze while the clock is stopped. */
	var clockEl = document.querySelector('.admin-clock');
	var live = false, running = false, base = 0, max = 0, at = 0;

	function anchor(src) {
		if (!src) { return; }
		live    = src.dataset.live === '1';
		running = src.dataset.running === '1';
		base    = parseInt(src.dataset.clock, 10) || 0;
		max     = parseInt(src.dataset.max, 10) || 0;
		at      = Date.now();
	}

	function two(n) { return String(n).padStart(2, '0'); }

	function tick() {
		var sec = running ? Math.min(base + Math.floor((Date.now() - at) / 1000), max) : base;
		if (live) {
			// Counts down from 20:00, like the rink clock.
			var into = sec % 1200;
			if (sec > 0 && into === 0) { into = 1200; }
			var left = 1200 - into;
			clockEl.textContent = two(Math.floor(left / 60)) + ':' + two(left % 60);
			clockEl.classList.toggle('is-stopped', !running);
		}
		Array.prototype.forEach.call(document.querySelectorAll('#pen-list [data-end]'), function (li) {
			var left = (parseInt(li.dataset.end, 10) || 0) - sec;
			li.hidden = left <= 0;
			var out = li.querySelector('.admin-pen-left');
			if (out && left > 0) { out.textContent = Math.floor(left / 60) + ':' + two(left % 60); }
		});
	}

	if (clockEl) {
		anchor(clockEl);
		tick();
		setInterval(tick, 1000);
	}
})();
