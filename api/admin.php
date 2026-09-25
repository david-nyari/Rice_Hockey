<?php
/*
 * Scorekeeper console.
 *
 * Designed for one hand, on a phone, in a cold rink: the two scoring buttons
 * are the largest targets and sit in the lower half of the screen where a
 * thumb reaches. Everything else is smaller and further up.
 *
 * Works without JavaScript (plain form POST, then redirect so a refresh cannot
 * resubmit a goal). JavaScript upgrades it to fetch so a tap does not reload
 * the page.
 */

require_once __DIR__ . '/../lib/module/sys-live.php';
require_once __DIR__ . '/../lib/module/sys-asset.php';

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$error  = '';
$notice = '';

if (isset($_GET['logout'])) {
    live_clear_cookie();
    header('Location: /admin.php');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_POST['action'] ?? '';

    if ($action === 'login') {
        if (env_get('ADMIN_PASSWORD') === '') {
            $error = 'ADMIN_PASSWORD is not set on this deployment.';
        } elseif (live_is_locked_out()) {
            $error = 'Too many attempts. Try again in 15 minutes.';
        } elseif (live_check_password($_POST['password'] ?? '')) {
            live_clear_failures();
            live_issue_cookie();
            header('Location: /admin.php');
            exit;
        } else {
            live_record_failure();
            $error = 'Incorrect password.';
        }
    } elseif (!live_is_admin()) {
        http_response_code(403);
        $error = 'Session expired. Sign in again.';
    } elseif (!live_csrf_valid($_POST['csrf'] ?? '')) {
        http_response_code(400);
        $error = 'Stale form. Reload and retry.';
    } else {
        $state = live_load() ?? live_default_state();

        if ($action === 'setup') {
            $state['opponent']      = trim($_POST['opponent'] ?? '') ?: 'Opponent';
            $state['opponent_logo'] = trim($_POST['opponent_logo'] ?? '');
            // Accept a full URL or a bare id; store the id either way.
            $yt = trim($_POST['youtube'] ?? '');
            if (preg_match('~(?:v=|youtu\.be/|embed/)([A-Za-z0-9_-]{11})~', $yt, $m)) {
                $yt = $m[1];
            }
            $state['youtube'] = preg_match('~^[A-Za-z0-9_-]{11}$~', $yt) ? $yt : '';
            $ok = live_save($state);
            $notice = $ok ? 'Saved.' : 'Could not reach the store.';
        } elseif ($action === 'reset') {
            $fresh                  = live_default_state();
            $fresh['opponent']      = $state['opponent'];
            $fresh['opponent_logo'] = $state['opponent_logo'];
            $fresh['youtube']       = $state['youtube'];
            live_save($fresh);
            header('Location: /admin.php');
            exit;
        } else {
            $next = live_apply($state, $action);
            if ($next === null) {
                $error = 'That action is not available right now.';
            } elseif (!live_save($next)) {
                $error = 'Could not reach the store. The tap was not recorded.';
            } else {
                header('Location: /admin.php');
                exit;
            }
        }
    }
}

$authed = live_is_admin();
$state  = $authed ? (live_load() ?? live_default_state()) : null;
$score  = $state ? live_score($state) : ['rice' => 0, 'opp' => 0];
$csrf   = live_csrf_token();

function h($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
?>
<!doctype html>
<html lang="en-US">
<head>
<title>Scorekeeper - Rice Hockey Club</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#00297f">
<link rel="stylesheet" href="<?= asset_v('/lib/css/live.css') ?>"/>
</head>
<body class="admin-body">

<?php if (!$authed): ?>

	<form class="admin-login" method="post" action="/admin.php">
		<h1>Scorekeeper</h1>
		<?php if ($error): ?><p class="admin-error"><?= h($error) ?></p><?php endif; ?>
		<input type="hidden" name="action" value="login">
		<label for="pw">Password</label>
		<input id="pw" name="password" type="password" autocomplete="current-password"
		       autofocus required inputmode="text">
		<button type="submit">Sign in</button>
	</form>

<?php elseif (!kv_available()): ?>

	<div class="admin-setup admin-standalone">
		<h1>Store not configured</h1>
		<p>This deployment has no KV connection, so there is nowhere to keep the
		   score. Add a Redis store in the Vercel dashboard and redeploy.</p>
	</div>

<?php else: ?>

	<div class="admin-status">
		<span class="admin-pill admin-pill-<?= h($state['status']) ?>"><?= h($state['status']) ?></span>
		<span>Period <?= $state['period'] > 0 ? (int) $state['period'] : '-' ?></span>
		<span class="admin-clock" data-clock="<?= live_game_seconds($state) ?>"
		      data-running="<?= $state['status'] === 'live' ? '1' : '0' ?>"></span>
		<a class="admin-signout" href="/admin.php?logout=1">Sign out</a>
	</div>

	<?php if ($error): ?><p class="admin-error"><?= h($error) ?></p><?php endif; ?>
	<?php if ($notice): ?><p class="admin-notice"><?= h($notice) ?></p><?php endif; ?>

	<div class="admin-scoreline">
		<div><span class="admin-team">Rice</span><span class="admin-num" id="n-rice"><?= (int) $score['rice'] ?></span></div>
		<div><span class="admin-team"><?= h($state['opponent']) ?></span><span class="admin-num" id="n-opp"><?= (int) $score['opp'] ?></span></div>
	</div>

	<!-- The two scoring buttons dominate and sit lowest: thumb territory. -->
	<form class="admin-pad" method="post" action="/admin.php" id="pad">
		<input type="hidden" name="csrf" value="<?= h($csrf) ?>">
		<div class="admin-pad-secondary">
			<button type="submit" name="action" value="undo" class="btn-undo">Undo</button>
			<button type="submit" name="action" value="period" class="btn-period"
			        data-confirm="<?= $state['period'] >= LIVE_PERIODS ? 'End the game?' : 'Start period ' . ((int) $state['period'] + 1) . '?' ?>">
				<?= $state['period'] >= LIVE_PERIODS ? 'End game' : ($state['period'] === 0 ? 'Start game' : 'Next period') ?>
			</button>
		</div>
		<div class="admin-pad-primary">
			<button type="submit" name="action" value="rice" class="btn-score btn-rice"
			        <?= $state['status'] === 'live' ? '' : 'disabled' ?>>
				<span class="btn-plus">+1</span><span class="btn-label">Rice</span>
			</button>
			<button type="submit" name="action" value="opp" class="btn-score btn-opp"
			        <?= $state['status'] === 'live' ? '' : 'disabled' ?>>
				<span class="btn-plus">+1</span><span class="btn-label"><?= h($state['opponent']) ?></span>
			</button>
		</div>
	</form>

	<details class="admin-setup">
		<summary>Game setup</summary>
		<form method="post" action="/admin.php">
			<input type="hidden" name="csrf" value="<?= h($csrf) ?>">
			<input type="hidden" name="action" value="setup">
			<label for="opp">Opponent</label>
			<input id="opp" name="opponent" value="<?= h($state['opponent']) ?>">
			<label for="logo">Opponent logo path</label>
			<input id="logo" name="opponent_logo" value="<?= h($state['opponent_logo']) ?>"
			       placeholder="/img/uni_logos/uh_logo.webp">
			<label for="yt">YouTube link or id</label>
			<input id="yt" name="youtube" value="<?= h($state['youtube']) ?>" placeholder="dQw4w9WgXcQ">
			<button type="submit">Save</button>
		</form>
		<form method="post" action="/admin.php" onsubmit="return confirm('Reset the score and clear all events?')">
			<input type="hidden" name="csrf" value="<?= h($csrf) ?>">
			<input type="hidden" name="action" value="reset">
			<button type="submit" class="btn-danger">Reset game</button>
		</form>
		<p class="admin-hint">Public page: <a href="/live.php">/live.php</a></p>
	</details>

	<script src="<?= asset_v('/lib/js/live-admin.js') ?>"></script>

<?php endif; ?>

</body>
</html>
