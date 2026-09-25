<?php
/*
 * Minimal Vercel KV / Upstash Redis client over the REST API.
 *
 * The PHP runtime on Vercel has no redis extension and no persistent local
 * filesystem, so commands go over HTTPS with curl. Vercel provisions
 * KV_REST_API_* ; the Upstash marketplace integration provisions
 * UPSTASH_REDIS_REST_* . Both are accepted so the same code works either way.
 *
 * Every helper returns null on failure rather than throwing. A rink-side
 * scoreboard should degrade to "unavailable" on the page, never to a 500.
 */

function env_get($name)
{
    $v = getenv($name);
    if ($v !== false && $v !== '') {
        return $v;
    }
    if (!empty($_ENV[$name]))    { return $_ENV[$name]; }
    if (!empty($_SERVER[$name])) { return $_SERVER[$name]; }
    return '';
}

/*
 * Set when a command could not reach the store at all. A missing key and an
 * unreachable store both yield null otherwise, and conflating them makes a
 * network blip look like "the game ended".
 */
$GLOBALS['kv_transport_failed'] = false;

function kv_failed()
{
    return !empty($GLOBALS['kv_transport_failed']);
}

function kv_config()
{
    $url = env_get('KV_REST_API_URL') ?: env_get('UPSTASH_REDIS_REST_URL');
    $tok = env_get('KV_REST_API_TOKEN') ?: env_get('UPSTASH_REDIS_REST_TOKEN');
    if ($url === '' || $tok === '') {
        return null;
    }
    return ['url' => rtrim($url, '/'), 'token' => $tok];
}

function kv_available()
{
    return kv_config() !== null;
}

/*
 * Send one Redis command as a JSON array, e.g. ['SET', 'key', '{...}'].
 * Returns the decoded "result" field, or null on any transport/API error.
 */
function kv_command(array $command)
{
    $cfg = kv_config();
    if ($cfg === null) {
        return null;
    }

    $ch = curl_init($cfg['url']);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . $cfg['token'],
            'Content-Type: application/json',
        ],
        CURLOPT_POSTFIELDS     => json_encode(array_values($command)),
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    // No curl_close(): a no-op since PHP 8.0 and deprecated in 8.5, where it
    // emits a notice that lands in the middle of the JSON response body.

    if ($body === false || $code < 200 || $code >= 300) {
        $GLOBALS['kv_transport_failed'] = true;
        return null;
    }
    $decoded = json_decode($body, true);
    if (!is_array($decoded) || array_key_exists('error', $decoded)) {
        $GLOBALS['kv_transport_failed'] = true;
        return null;
    }
    return $decoded['result'] ?? null;
}

function kv_get_json($key)
{
    $raw = kv_command(['GET', $key]);
    if (!is_string($raw) || $raw === '') {
        return null;
    }
    $val = json_decode($raw, true);
    return is_array($val) ? $val : null;
}

function kv_set_json($key, array $value)
{
    $raw = json_encode($value, JSON_UNESCAPED_SLASHES);
    return kv_command(['SET', $key, $raw]) !== null;
}

/*
 * Increment a counter that expires on its own. Used for login throttling:
 * one key per client, so a burst of guesses trips the limit and then ages out
 * without anything needing to clean up after it.
 */
function kv_incr_with_ttl($key, $ttl_seconds)
{
    $n = kv_command(['INCR', $key]);
    if ($n === null) {
        return null;
    }
    if ((int) $n === 1) {
        kv_command(['EXPIRE', $key, (string) $ttl_seconds]);
    }
    return (int) $n;
}
