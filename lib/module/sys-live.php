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
        'period'         => 0,           // 0 until the first period starts
        'period_started' => null,        // ms; when the current period began
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
        if (!empty($e['undone'])) {
            continue;
        }
        $team = ($e['team'] === 'rice') ? 'rice' : 'opp';
        $score[$team]++;
    }
    return $score;
}

/*
 * Seconds elapsed in the game right now. Derived from when the current period
 * started rather than from a stored ticking value, so it stays correct across
 * stateless function invocations and needs no start/stop buttons.
 */
function live_game_seconds(array $state)
{
    if ($state['period'] < 1 || $state['period_started'] === null) {
        return 0;
    }
    $into = (live_now_ms() - (int) $state['period_started']) / 1000;
    $into = max(0, min(LIVE_PERIOD_LENGTH, $into));
    return (int) round((($state['period'] - 1) * LIVE_PERIOD_LENGTH) + $into);
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
 */
function live_apply(array $state, $action)
{
    switch ($action) {
        case 'rice':
        case 'opp':
            if ($state['status'] !== 'live') {
                return null;
            }
            $state['events'][] = [
                'seq'      => live_next_seq($state),
                'team'     => $action,
                'period'   => (int) $state['period'],
                'game_sec' => live_game_seconds($state),
                'ts'       => live_now_ms(),
                'undone'   => false,
            ];
            return $state;

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
                $state['status'] = 'final';
                return $state;
            }
            $state['period']         = (int) $state['period'] + 1;
            $state['period_started'] = live_now_ms();
            $state['status']         = 'live';
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
        if (!empty($e['undone'])) {
            continue;
        }
        $events[] = [
            'team'     => $e['team'],
            'period'   => (int) $e['period'],
            'game_sec' => (int) $e['game_sec'],
        ];
    }
    return [
        'status'        => $state['status'],
        'opponent'      => $state['opponent'],
        'opponent_logo' => $state['opponent_logo'],
        'period'        => (int) $state['period'],
        'periods'       => LIVE_PERIODS,
        'period_length' => LIVE_PERIOD_LENGTH,
        'game_sec'      => live_game_seconds($state),
        'score'         => live_score($state),
        'events'        => $events,
        'youtube'       => $state['youtube'],
        'updated'       => (int) $state['updated'],
    ];
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
