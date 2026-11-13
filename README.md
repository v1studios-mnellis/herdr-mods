# herdr-mods — working repo for my herdr-app mods

Development home for the herdr-app mods I maintain (`v1studios-mnellis`).
Each mod lives self-contained in `mods/<name>/`:

```
mods/<name>/
  main.js  lib.js  mod.json     the mod itself (copy this folder into ~/.config/herdr-app/mods/<name>/)
  RECIPE.md                     the build brief (what it is, what you see, how it behaves, built from)
  SPEC.md                       original requirements (if any)
  preview.png                   screenshot for the store listing
  keys.json                     key bindings the mod expects (merge into ~/.config/herdr-app/keys.json)
```

## Install from this repo (laptop or desktop)

Copy one mod folder out of this repo into the app:

```bash
# e.g. from the GitHub folder view: github.com/v1studios-mnellis/herdr-mods/tree/main/mods/<name>
cp -r mods/<name> ~/.config/herdr-app/mods/<name>      # never overwrite an existing name; rename instead
# merge keys.json sections/keys (ask before replacing a key you already use)
herdr-app check ~/.config/herdr-app/mods/<name>
```

## Publish to the store (herdr.dev/mods)

herdr.dev lists a **public GitHub repo** that has the repo topic `herdr-mod` and
the shareable layout — it shows up at `herdr.dev/mods/<owner>/<name>` within the hour.
For a single mod that means its own repo laid out like this:

```
<name>/                     (repo root)
  mods/<name>/              the mod folder, exactly as here
  RECIPE.md                 copied from mods/<name>/RECIPE.md
  preview.png               copied from mods/<name>/preview.png
  keys.json                 copied from mods/<name>/keys.json (optional)
```

then `gh api -X PUT repos/<owner>/<name>/topics --raw-field 'names[]=herdr-mod'`.
`hermes-kanban` and `previews` are published this way as their own repos
(github.com/v1studios-mnellis/hermes-kanban, github.com/v1studios-mnellis/previews).
**Listings are per mod:** this working repo deliberately carries no `herdr-mod`
topic, so herdr.dev shows one entry per published mod instead of the whole
working repo. Promote a mod by splitting its folder into a dedicated repo when
it is store-ready.

## Mods

| Mod | What it is | Store |
|---|---|---|
| `hermes-kanban` | Native pane for the Hermes kanban board on a paired machine (`hermes kanban` CLI); full CRUD, 10 s poll | herdr.dev/mods/v1studios-mnellis/hermes-kanban |
| `previews` | Floating right-edge drawer of agent preview screenshots (`.herdr-previews/`) with pop-out viewer, pin/draw annotations, approve/send feedback to the agent | herdr.dev/mods/v1studios-mnellis/previews |
