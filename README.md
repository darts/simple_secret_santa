# Secret Santa

Entirely vibe-coded, one-time Secret Santa draws for truly terrible T-shirts. Node.js, no dependencies.

## Run

Extract the bundle into a fresh directory:

```sh
tar xzf secretsanta-vps.tar.gz
cd secretsanta
cp .env.example .env
```

The participant file is empty. Add participants before you start the app. See [Participants](#participants).

For HTTPS, set `PUBLIC_ORIGIN=https://your-domain` in `.env`. Leave it empty for local HTTP.

With Docker Compose installed, prepare Linux permissions and start:

```sh
sudo chown -R 1000:1000 data
sudo chmod 700 data
sudo chmod 600 data/participants.txt
docker compose up -d --build
```

Open http://localhost:3000. For the VPS, add [Caddyfile.example](Caddyfile.example) to your host's Caddy config, replace its domain, and reload Caddy. It proxies to `127.0.0.1:3000`.

## Participants

Edit `data/participants.txt`:

1. Add at least two participants. Put each participant on a separate line.
2. Use a unique name for each participant. Do not put spaces in a name.
3. After a participant's name, add the names of people they must not draw. Use a space between names.
4. Give every excluded person a separate line in the list. Use the same spelling and capital letters.

Example:

```text
Alice Bob
Bob
Cara
Dave
```

In this example, Alice cannot draw Bob. Bob can draw Alice.

Each participant gives one gift and receives one gift. Participants cannot draw their own names.

The exclusions must allow a complete draw. If they do not, change the list before you start the app.

## State

Assignments and opened flags persist in `data/state.json`. Changing participants or exclusions automatically redraws and reopens everyone. Whitespace and reordering are ignored; invalid edits pause reveals until corrected.

To redraw without changing the list:

```sh
docker compose stop santa
sudo rm data/state.json
docker compose start santa
```

Partners are shown once and excluded from the public list. There are no accounts: anyone with the link can open a name.
