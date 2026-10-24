<?php
/*
 * Live game state: the model, the clock, and admin auth.
 *
 * One KV key holds one game as a small JSON blob. The score is *derived* from
 * the event list rather than stored alongside it, so undo cannot leave the
 * displayed score and the chart disagreeing with each other.
 *
 * Concurrency: writes are read-modify-write, so two admins tapping at the same
 * instant could lose one tap. One person runs a scoreboard, so this is left
 * deliberately simple; if that ever changes, move events to a Redis list and
 * RPUSH them instead.
 */

require_once __DIR__ . '/sys-kv.php';

const LIVE_KEY           = 'rh:game:current';
const LIVE_PERIODS       = 3;
const LIVE_PERIOD_LENGTH = 1200; // 20 minutes, in seconds
const LIVE_COOKIE        = 'rh_admin';
const LIVE_SESSION_TTL   = 43200; // 12 hours — one game day
const LIVE_MAX_ATTEMPTS  = 10;
const LIVE_LOCKOUT_TTL   = 900;   // 15 minutes

// Penalty length in minutes => label. A misconduct does not take a skater off
// the ice, so it is shown but never counts toward strength.
const LIVE_PENALTY_MINUTES = [2 => 'Minor', 4 => 'Double minor', 5 => 'Major', 10 => 'Misconduct'];
const LIVE_INFRACTIONS = [
    'Boarding', 'Charging', 'Checking from behind', 'Cross-checking',
    'Delay of game', 'Elbowing', 'Fighting', 'Head contact', 'High-sticking',
    'Holding', 'Holding the stick', 'Hooking', 'Interference', 'Kneeing',
    'Roughing', 'Slashing', 'Spearing', 'Too many players', 'Tripping',
    'Unsportsmanlike conduct', 'Other',
];

function live_now_ms()
{
    return (int) round(microtime(true) * 1000);
}

function live_default_state()
{
    return [
        'version'        => 1,
        'status'         => 'scheduled', // scheduled | live | final
        'opponent'       => 'Opponent',
        'opponent_logo'  => '',
        'opponent_color' => '',          // #rrggbb; '' uses the page default
        'period'         => 0,          // 0 until the first period starts
        'period_started' => null,        // ms; when the current period began
        'paused_at'      => null,        // ms; set while the clock is stopped
        'events'         => [],
        'youtube'        => '',          // video id only, not a full URL
        'updated'        => live_now_ms(),
    ];
}

function live_load()
{
    $state = kv_get_json(LIVE_KEY);
    if ($state === null) {
        return null;
    }
    return array_merge(live_default_state(), $state);
}

function live_save(array $state)
{
    $state['updated'] = live_now_ms();
    return kv_set_json(LIVE_KEY, $state);
}

/*
 * Score is the sum of events that have not been undone. Undone events are kept
 * so the log stays append-only and an accidental undo is still auditable.
 */
function live_score(array $state)
{
    $score = ['rice' => 0, 'opp' => 0];
    foreach ($state['events'] as $e) {
        if (!empty($e['undone']) || !live_is_goal($e)) {
            continue;
        }
        $team = ($e['team'] === 'rice') ? 'rice' : 'opp';
        $score[$team]++;
    }
    return $score;
}

/* Events from before penalties existed carry no kind, and were all goals. */
function live_is_goal(array $e)
{
    return ($e['kind'] ?? 'goal') === 'goal';
}

/*
 * Penalties with the game second each one actually ends. Derived from the
 * event log rather than stored, for the same reason the score is: undoing a
 * power-play goal must also undo the early release it caused.
 */
function live_penalties(array $state)
{
    $pens = [];
    foreach ($state['events'] as $e) {
        if (!empty($e['undone'])) {
            continue;
        }
        if (live_is_goal($e)) {
            live_release_on_goal($pens, $e);
            continue;
        }
        $e['end_sec'] = (int) $e['game_sec'] + 60 * (int) $e['minutes'];
        if (isset($e['cleared_sec'])) {
            $e['end_sec'] = min($e['end_sec'], (int) $e['cleared_sec']);
        }
        $pens[] = $e;
    }
    return $pens;
}

/*
 * A goal against a shorthanded team ends its minor with the least time left.
 * A double minor only loses the two minutes being served. Majors and
 * misconducts always serve full time. Only penalties assessed before the goal
 * are in $pens, because the log is walked in order.
 */
function live_release_on_goal(array &$pens, array $goal)
{
    $t       = (int) $goal['game_sec'];
    $against = $goal['team'] === 'rice' ? 'opp' : 'rice';
    $count   = ['rice' => 0, 'opp' => 0];
    $pick    = null;
    $pickLeft = 0;

    foreach ($pens as $i => $p) {
        $min = (int) $p['minutes'];
        if ($p['end_sec'] <= $t || $min === 10) {
            continue;
        }
        $count[$p['team']]++;
        if ($p['team'] !== $against || $min > 4) {
            continue;
        }
        $left = $p['end_sec'] - $t;
        if ($min === 4 && $left > 120) {
            $left -= 120; // still in the first half of a double minor
        }
        if ($pick === null || $left < $pickLeft) {
            $pick     = $i;
            $pickLeft = $left;
        }
    }

    if ($pick === null || $count[$against] <= $count[$goal['team']]) {
        return; // not a power-play goal
    }
    $left = $pens[$pick]['end_sec'] - $t;
    $pens[$pick]['end_sec'] = ((int) $pens[$pick]['minutes'] === 4 && $left > 120) ? $t + 120 : $t;
}

/*
 * Seconds elapsed in the game right now. Derived from when the current period
 * started rather than from a stored ticking value, so it stays correct across
 * stateless function invocations. A stopped clock reads as of the moment it
 * stopped; restarting it moves period_started forward by the stoppage.
 */
function live_game_seconds(array $state)
{
    if ($state['period'] < 1 || $state['period_started'] === null) {
        return 0;
    }
    $at   = $state['paused_at'] ?? live_now_ms();
    $into = ($at - (int) $state['period_started']) / 1000;
    $into = max(0, min(LIVE_PERIOD_LENGTH, $into));
    return (int) round((($state['period'] - 1) * LIVE_PERIOD_LENGTH) + $into);
}

function live_clock_running(array $state)
{
    return $state['status'] === 'live' && $state['period_started'] !== null
        && $state['paused_at'] === null;
}

function live_next_seq(array $state)
{
    $max = 0;
    foreach ($state['events'] as $e) {
        $max = max($max, (int) $e['seq']);
    }
    return $max + 1;
}

/*
 * Apply one admin action. Returns the new state, or null if the action was not
 * valid for the current state (e.g. scoring before the game has started).
 * $input is the posted form, for actions that carry more than their name.
 */
function live_apply(array $state, $action, array $input = [])
{
    switch ($action) {
        case 'rice':
        case 'opp':
            if ($state['status'] !== 'live') {
                return null;
            }
            $state['events'][] = [
                'seq'      => live_next_seq($state),
                'kind'     => 'goal',
                'team'     => $action,
                'period'   => (int) $state['period'],
                'game_sec' => live_game_seconds($state),
                'ts'       => live_now_ms(),
                'undone'   => false,
            ];
            return $state;

        // Penalties go in the same log as goals so Undo takes back whichever
        // was entered last. Fields are matched strictly against fixed lists:
        // a posted array, or anything not offered by the form, is refused.
        case 'penalty':
            $player = $input['player'] ?? '';
            if ($state['status'] !== 'live'
                || !in_array($input['team'] ?? '', ['rice', 'opp'], true)
                || !in_array($input['minutes'] ?? '', array_map('strval', array_keys(LIVE_PENALTY_MINUTES)), true)
                || !in_array($input['infraction'] ?? '', LIVE_INFRACTIONS, true)
                || !is_string($player) || !preg_match('~^\d{0,3}$~', trim($player))) {
                return null;
            }
            $state['events'][] = [
                'seq'        => live_next_seq($state),
                'kind'       => 'penalty',
                'team'       => $input['team'],
                'player'     => trim($player),
                'infraction' => $input['infraction'],
                'minutes'    => (int) $input['minutes'],
                'period'     => (int) $state['period'],
                'game_sec'   => live_game_seconds($state),
                'ts'         => live_now_ms(),
                'undone'     => false,
            ];
            return $state;

        // End a penalty early by hand: a goal the release rule did not catch,
        // or a penalty entered against the wrong player.
        case 'penalty_end':
            $seq = $input['seq'] ?? '';
            if (!is_string($seq) || !ctype_digit($seq)) {
                return null;
            }
            $now = live_game_seconds($state);
            foreach (live_penalties($state) as $p) {
                if ((int) $p['seq'] !== (int) $seq || $p['end_sec'] <= $now) {
                    continue;
                }
                foreach ($state['events'] as $i => $e) {
                    if ((int) $e['seq'] === (int) $seq) {
                        $state['events'][$i]['cleared_sec'] = $now;
                        return $state;
                    }
                }
            }
            return null;

        case 'undo':
            for ($i = count($state['events']) - 1; $i >= 0; $i--) {
                if (empty($state['events'][$i]['undone'])) {
                    $state['events'][$i]['undone'] = true;
                    return $state;
                }
            }
            return null; // nothing left to undo

        case 'period':
            if ($state['status'] === 'final') {
                return null;
            }
            if ($state['period'] >= LIVE_PERIODS) {
                $state['status']    = 'final';
                $state['paused_at'] = null;
                return $state;
            }
            // A period opens with the clock stopped at 00:00: the period is
            // usually started during intermission, and play begins at the
            // faceoff, which is when the scorekeeper starts the clock.
            $now                     = live_now_ms();
            $state['period']         = (int) $state['period'] + 1;
            $state['period_started'] = $now;
            $state['paused_at']      = $now;
            $state['status']         = 'live';
            return $state;

        // Stop or start the clock. Stopping records when; starting shifts the
        // period's start forward by the stoppage so elapsed time skips it.
        case 'clock':
            if ($state['status'] !== 'live' || $state['period_started'] === null) {
                return null;
            }
            $now = live_now_ms();
            if ($state['paused_at'] === null) {
                $state['paused_at'] = $now;
            } else {
                $state['period_started'] = (int) $state['period_started'] + ($now - (int) $state['paused_at']);
                $state['paused_at']      = null;
            }
            return $state;
    }
    return null;
}

/*
 * The public shape. This is what both the live page and the polling endpoint
 * serve, so there is exactly one definition of what a viewer can see.
 */
function live_public(array $state)
{
    $events = [];
    foreach ($state['events'] as $e) {
        if (!empty($e['undone']) || !live_is_goal($e)) {
            continue;
        }
        $events[] = [
            'team'     => $e['team'],
            'period'   => (int) $e['period'],
            'game_sec' => (int) $e['game_sec'],
        ];
    }
    // Every penalty, expired or not: the page decides what is still running
    // from its own ticking clock, since expiry changes nothing on the server.
    $penalties = [];
    foreach (live_penalties($state) as $p) {
        $penalties[] = [
            'team'       => $p['team'],
            'player'     => $p['player'],
            'infraction' => $p['infraction'],
            'minutes'    => (int) $p['minutes'],
            'period'     => (int) $p['period'],
            'game_sec'   => (int) $p['game_sec'],
            'end_sec'    => (int) $p['end_sec'],
        ];
    }
    return [
        'status'        => $state['status'],
        'opponent'      => $state['opponent'],
        'opponent_logo' => $state['opponent_logo'],
        'opponent_color' => $state['opponent_color'],
        'opponent_ink'  => $state['opponent_color'] !== '' ? live_ink_on($state['opponent_color']) : '',
        'period'        => (int) $state['period'],
        'periods'       => LIVE_PERIODS,
        'period_length' => LIVE_PERIOD_LENGTH,
        'game_sec'      => live_game_seconds($state),
        'clock_running' => live_clock_running($state),
        'score'         => live_score($state),
        'events'        => $events,
        'penalties'     => $penalties,
        'youtube'       => $state['youtube'],
        'updated'       => (int) $state['updated'],
    ];
}

/* --------------------------------------------------------------- colour -- */

const LIVE_RICE_COLOR    = '#0c3468'; // matches --live-rice and --ov-rice
const LIVE_SURFACE_COLOR = '#fcfcfb'; // matches --live-surface (light)

/* '#RRGGBB' -> '#rrggbb', or '' for anything else. */
function live_hex_color($s)
{
    return (is_string($s) && preg_match('~^#[0-9a-fA-F]{6}$~', $s)) ? strtolower($s) : '';
}

function live_linear_rgb($hex)
{
    $out = [];
    foreach ([1, 3, 5] as $i) {
        $c = hexdec(substr($hex, $i, 2)) / 255;
        $out[] = $c <= 0.04045 ? $c / 12.92 : pow(($c + 0.055) / 1.055, 2.4);
    }
    return $out;
}

function live_luminance($hex)
{
    [$r, $g, $b] = live_linear_rgb($hex);
    return 0.2126 * $r + 0.7152 * $g + 0.0722 * $b;
}

function live_contrast($a, $b)
{
    $la = live_luminance($a);
    $lb = live_luminance($b);
    return (max($la, $lb) + 0.05) / (min($la, $lb) + 0.05);
}

/* Text colour for a label sitting on a fill of $hex: whichever reads better. */
function live_ink_on($hex)
{
    return live_contrast($hex, '#ffffff') >= live_contrast($hex, '#111111') ? '#ffffff' : '#111111';
}

/* Perceptual distance between two colours (OKLab, x100). Under ~15 most
 * people cannot reliably tell the two apart at chart-mark size. */
function live_color_distance($a, $b)
{
    $lab = function ($hex) {
        [$r, $g, $b] = live_linear_rgb($hex);
        $l = pow(0.4122214708 * $r + 0.5363325363 * $g + 0.0514459929 * $b, 1 / 3);
        $m = pow(0.2119034982 * $r + 0.6806995451 * $g + 0.1073969566 * $b, 1 / 3);
        $s = pow(0.0883024619 * $r + 0.2817188376 * $g + 0.6299787005 * $b, 1 / 3);
        return [
            0.2104542553 * $l + 0.7936177850 * $m - 0.0040720468 * $s,
            1.9779984951 * $l - 2.4285922050 * $m + 0.4505937099 * $s,
            0.0259040371 * $l + 0.7827717662 * $m - 0.8086757660 * $s,
        ];
    };
    [$l1, $a1, $b1] = $lab($a);
    [$l2, $a2, $b2] = $lab($b);
    return 100 * sqrt(($l1 - $l2) ** 2 + ($a1 - $a2) ** 2 + ($b1 - $b2) ** 2);
}

/* Why a chosen opponent colour will be hard to read, or '' if it is fine.
 * Advisory: the timeline also separates teams by side, so it still works. */
function live_color_warning($hex)
{
    if (live_color_distance($hex, LIVE_RICE_COLOR) < 15) {
        return 'That colour is very close to Rice navy, so viewers may mix up the teams.';
    }
    if (live_contrast($hex, LIVE_SURFACE_COLOR) < 3) {
        return 'That colour is very pale and will be hard to see on the white page.';
    }
    return '';
}

/* ------------------------------------------------------------------ auth -- */

function live_admin_secret()
{
    $s = env_get('ADMIN_SECRET');
    if ($s) {
        return $s;
    }
    // Fall back to deriving one from the password so a deploy that only sets
    // ADMIN_PASSWORD still gets unforgeable cookies. Rotating the password
    // then also invalidates existing sessions, which is the safer default.
    return hash('sha256', 'rh-live|' . env_get('ADMIN_PASSWORD'));
}

function live_sign($payload)
{
    return hash_hmac('sha256', $payload, live_admin_secret());
}

function live_issue_cookie()
{
    $expires = time() + LIVE_SESSION_TTL;
    $token   = $expires . '.' . live_sign((string) $expires);
    setcookie(LIVE_COOKIE, $token, [
        'expires'  => $expires,
        'path'     => '/',
        'secure'   => !empty($_SERVER['HTTPS']),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function live_clear_cookie()
{
    setcookie(LIVE_COOKIE, '', ['expires' => time() - 3600, 'path' => '/']);
}

function live_is_admin()
{
    $raw = $_COOKIE[LIVE_COOKIE] ?? '';
    if (!is_string($raw) || strpos($raw, '.') === false) {
        return false;
    }
    [$expires, $sig] = explode('.', $raw, 2);
    if (!ctype_digit($expires) || (int) $expires < time()) {
        return false;
    }
    return hash_equals(live_sign($expires), $sig);
}

/*
 * Throttle guessing. Keyed per client rather than globally so one attacker
 * cannot lock the actual scorekeeper out mid-game.
 */
function live_attempt_key()
{
    $ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $ip = trim(explode(',', $ip)[0]);
    return 'rh:login:' . hash('sha256', $ip);
}

function live_is_locked_out()
{
    $n = kv_command(['GET', live_attempt_key()]);
    return $n !== null && (int) $n >= LIVE_MAX_ATTEMPTS;
}

function live_record_failure()
{
    kv_incr_with_ttl(live_attempt_key(), LIVE_LOCKOUT_TTL);
}

function live_clear_failures()
{
    kv_command(['DEL', live_attempt_key()]);
}

function live_check_password($given)
{
    $expected = env_get('ADMIN_PASSWORD');
    if ($expected === '') {
        return false; // never allow login when no password is configured
    }
    return hash_equals($expected, (string) $given);
}

/* CSRF token, bound to the session cookie so it cannot be replayed elsewhere */
function live_csrf_token()
{
    return live_sign('csrf|' . ($_COOKIE[LIVE_COOKIE] ?? ''));
}

function live_csrf_valid($given)
{
    return is_string($given) && hash_equals(live_csrf_token(), $given);
}
