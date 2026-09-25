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
				// The POST redirects to a full render; lift the two numbers out
				// of it rather than reloading the whole page.
				var doc = new DOMParser().parseFromString(html, 'text/html');
				['n-rice', 'n-opp'].forEach(function (id) {
					var from = doc.getElementById(id);
					var to   = document.getElementById(id);
					if (from && to) { to.textContent = from.textContent; }
				});
				if (navigator.vibrate) { navigator.vibrate(15); }
				setBusy(false);
			})
			.catch(function () {
				// Do not leave the operator guessing whether the goal landed.
				setBusy(false);
				window.alert('That tap did not reach the server. Check signal and try again.');
			});
	});

	/* Local clock, re-anchored on every page render from the server value. */
	var clockEl = document.querySelector('.admin-clock');
	if (clockEl && clockEl.dataset.running === '1') {
		var base = parseInt(clockEl.dataset.clock, 10) || 0;
		var at   = Date.now();
		var tick = function () {
			var sec = base + Math.floor((Date.now() - at) / 1000);
			var into = sec % 1200;
			clockEl.textContent =
				String(Math.floor(into / 60)).padStart(2, '0') + ':' +
				String(into % 60).padStart(2, '0');
		};
		tick();
		setInterval(tick, 1000);
	}
})();
