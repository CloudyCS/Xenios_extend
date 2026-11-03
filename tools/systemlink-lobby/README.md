# XeniOS System Link lobby

A Cloudflare Worker with one Durable Object per room. It tells the players in a
System Link room where the others can be reached, and hands out the room secret
and TURN credentials. Game traffic never goes through it. The wire protocol is
in [PROTOCOL.md](PROTOCOL.md).

## Develop and test

    npm install
    npm test

The test starts a mock TURN credentials server and `wrangler dev` locally. It
never talks to a Cloudflare account. The 60-second silence drop is not covered
(it would make the test slow).

## Deploy (account owner)

    npx wrangler login
    npx wrangler secret put TURN_KEY_ID
    npx wrangler secret put TURN_KEY_API_TOKEN
    npx wrangler secret put CF_ACCOUNT_ID
    npx wrangler secret put CF_ANALYTICS_TOKEN
    npx wrangler deploy

Run these from this folder. Create the TURN key in the Cloudflare dashboard
under Realtime -> TURN; its key ID and API token are the two secrets. Without
them the lobby hands out STUN only, and players only connect directly.
`CF_ACCOUNT_ID` is the account ID on the dashboard's overview page, and
`CF_ANALYTICS_TOKEN` an API token (My Profile -> API Tokens) with only
Account -> Account Analytics -> Read. Without those two the lobby can't read
its TURN usage, so it hands out STUN only. It deploys to
`https://xenios-systemlink.xenios.workers.dev`, which is the
`systemlink_lobby` default.

## Costs

Keep the account on the Workers Free plan. There, Workers and Durable Objects
stop at their daily limits (joins fail until 00:00 UTC) and are never billed.

TURN is billed apart from the plan: the first 1,000 GB a month sent to players
are free, then $0.05 per GB, with no spending cap. The lobby keeps its own (see
PROTOCOL.md): no TURN credentials once the account's TURN traffic over the last
31 days reaches 400 GB, or while it can't read that; at most 32 live at once
and 4 to one address, each good for an hour; all revoked at the cap. Players
then connect directly where their networks allow.

That leaves 600 GB between the cap and the first bill, for what credentials
already handed out send after it. Cloudflare says usage stops counting the
moment a credential expires, which is at most an hour after the cap; it doesn't
say whether revoking one stops it sooner, or how late its usage numbers are.
System Link sends tens of KB a second per player, so 32 players for that hour
is a few GB. Someone who took credentials to relay other traffic through
Cloudflare at its per-client rate (about 100 Mbps) could send more than 600 GB
in that hour, unless revoking stops them. So the cap is a strong guard, not a
guarantee. To rule out a bill entirely, turn TURN off: delete the `TURN_KEY_ID`
secret (or the TURN key in the dashboard) and the lobby hands out STUN only;
players whose networks block direct connections then can't play together.

## Limits

- Workers Free allows 100,000 Durable Object requests a day. WebSocket
  messages count 20 to 1, so a player costs at most about 150 a day while a
  game has System Link open. Past the limit, joins fail until the next day.
  The player counts behind `GET /v1/online` add one request per public lobby
  change and per busy lobby every 5 minutes, and at most one a minute per
  Worker instance answering `/v1/online`.
- Cloudflare TURN: see Costs. A usage notification for Realtime in the
  dashboard is a good second check.
