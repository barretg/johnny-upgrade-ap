# Hosting the editor

Hosting is now **optional**. The same editor ships as a self-contained
Tampermonkey script — `dist/johnny-upgrade-map-editor.user.js`, see
`mapkit/SHARING.md` — which needs no server at all and keeps levels in the
browser. Host this when several people want one shared library of maps on disk,
or when you want the SDK-backed quick-run page.

The editor is a small Node server with no dependencies. Node 18+ is all it needs.

```
node editor/server.js --host 0.0.0.0 --port 7732 --token some-shared-secret
```

Everyone opens `http://your-server:7732/?token=some-shared-secret` once; the
token is remembered in a cookie after that.

| flag | meaning |
|---|---|
| `--host` | bind address. Defaults to `127.0.0.1`. Use `0.0.0.0` to share. |
| `--port` | defaults to `7732` |
| `--token` | shared secret. Optional, but see below. |
| `--sdk` | path to the game SDK. Defaults to `../scratch-work/johnny-upgrade-sdk`. |

## Read this before exposing it

The editor **writes files** and has no concept of users. Anyone who can reach
the port can read, edit and overwrite every map, and the token is a lock on a
door rather than authentication — one secret, shared by everybody, sent as a
query parameter.

That is fine for a private server among friends. It is not fine on the public
internet. If the box is internet-facing, put it behind whatever auth it already
has — a VPN, or a reverse proxy with basic auth — rather than relying on the
token.

Binding to a non-local address without `--token` prints a warning at startup.

## What the server needs on disk

**The game SDK** — `js/` and `assets/` from Johnny Upgrade. Quick-run and the
level select serve the real game from it, so without it those 404 and only the
editor canvas works. It is not in this repo and should not be redistributed;
whoever hosts supplies their own copy and points `--sdk` at it.

**The extracted tiles** — the texture palette reads `tiles/extracted/`, which is
gitignored for the same reason. Build them once on the server:

```
node tools/extract-from-mural.js
node tools/reconstruct-grass.js
```

Both read the SDK's artwork and write into `tiles/`. The server prints a warning
at startup if either is missing, since an empty palette otherwise looks like an
editor bug rather than missing setup.

**Maps** live in `mapeditor/maps/`, one `.json` plus a `.png` thumbnail each.
That directory is the shared library — back it up like anything else people are
making things in.

## What people get

- `/` — the editor
- `/game` — level select and play, the same thing the userscript provides
- `/play?map=<id>` — quick-run for a single map, with the debug upgrade panel

Maps saved by anyone appear for everyone, since they all sit in one directory.
There is no locking, so two people editing the same map at once will overwrite
each other. Worth agreeing who owns what, or giving each person their own
instance and pooling the `.json` files.

## Running it in a container

The server is plain Node with no dependencies, so containerising it is
straightforward: install Node, copy or clone the repo, mount a copy of the game
at some path, point `JU_SDK` at it, and run `node editor/server.js`.

Two things are worth knowing before you write that Dockerfile:

- **The image must not contain the game artwork.** Exclude `scratch-work/` and
  `mapeditor/tiles/`. The SDK belongs as a read-only mount at runtime.
- **The tile palette can rebuild itself.** `mapkit/tiles.json` is tracked and is
  a list of source rectangles, not art, so on first boot:

  ```
  node tools/build-tiles-from-recipe.js --sdk "$JU_SDK"
  ```

  rebuilds `tiles/extracted/` from a mounted SDK, using the same code the browser
  runs. Without an SDK the editor still starts, just with no textures and no way
  to run a level.

Point `mapeditor/maps` at a volume, or every map is lost on redeploy.

## Sharing levels without hosting anything

Hosting is convenient but not required — see `mapkit/SHARING.md`. The userscript
plus a `.json` file is enough for someone to play a level, and they can import it
from their own machine.
