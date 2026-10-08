# Bamboi-fork: werkafspraken voor agents

Deze repo is de fork van `karrioapi/karrio` die Bamboi zelf host. `AGENTS.md`, `CLAUDE.md` en `.claude/` komen van upstream en blijven ongewijzigd, op de verwijzing naar dit bestand na. Dit bestand bevat alleen wat voor de fork geldt en gaat voor waar het botst.

## Productiebranch

**`main` van `Bamboi-tech/karrio` is de productiebranch.** PR's gaan daarheen, nooit naar upstream. `gh` valt in deze checkout terug op upstream (remote `upstream`), dus geef altijd `--repo Bamboi-tech/karrio` mee, ook bij `gh pr create`, `gh workflow run` en `gh run view`.

## Absoluut

1. **Productie is alleen-lezen voor agents.** Lezen mag; elke actie op productie (Karrio, vervoerders, Monta) alleen met expliciete opdracht per actie. Nooit een label kopen of een zending aanmaken bij een vervoerder als test.
2. **Geen SSH.** Wie hier werkt heeft geen toegang tot de servers. Wat SSH of `docker exec` vraagt, schrijf je uit als exact commando voor de beheerder. Zelf controleren kan via GitHub Actions (runs en logs) en de publieke URL's.
3. **Deploys draait een mens** via de workflows hieronder; een agent bereidt het commando voor en dispatcht niet zelf.
4. **Geen commits of pushes zonder opdracht**, nooit zelf mergen. Commitformaat zoals upstream (`.claude/rules/git-workflow.md`), zonder `Co-Authored-By` of andere tool-attributie.
5. **Beste oplossing voor de lange termijn.** Weeg op kwaliteit, onderhoudbaarheid en de juiste laag; bouw- of deploytijd is nooit het argument.
6. **Worktrees in één map:** `<werkmap>/.worktrees/<feature>/karrio`, nooit in `/tmp` of `.claude/worktrees`.
7. **Taal:** overleg in het Nederlands, direct. Code, commits en code-commentaar in het Engels. Nooit het paragraafteken; verwijs naar secties met kale nummers ("3, regel 4").

## Release en deploy

8. Na een merge in `main` bouwt `gh workflow run build-karrio-images.yml --repo Bamboi-tech/karrio --ref main` het server- en dashboard-image, met tag `<VERSION>-<sha7>` (`apps/api/karrio/server/VERSION`; de tag staat in de job-samenvatting).
9. Zet die tag als `karrio_tag` in `ansible/vars/staging.yaml` én `ansible/vars/production.yaml` (altijd dezelfde), in één commit `release: pin <tag> (<inhoud>)` op `main`. Daarna: `gh workflow run update-karrio.yml --repo Bamboi-tech/karrio --ref main -f env=staging`, controleren, dan `-f env=production`. Een deploy duurt ~12 minuten.
10. Gebruik de `karrio_tag`-input van `update-karrio.yml` niet voor productie: de pin in `production.yaml` is het record van wat er draait, en andere tooling leest hem.
11. Na een deploy is de API tot ~5 minuten onbereikbaar (502 via caddy of geen verbinding) terwijl `karrio migrate` en de static sync draaien: trage boot, geen crash-loop. Pas daarna is het een probleem.
12. **Secrets zijn gesplitst omdat de fork publiek is.** `GCP_GAR_KEY` kan alleen images pushen (build), `GCP_SA_KEY` alleen monitoring snoozen (deploy). Los een push-denied nooit op door `GCP_SA_KEY` ruimer te maken. De vault staat niet in git; de workflow schrijft hem uit de environment-secret `ANSIBLE_VAULT_ENV_FILE`. Secrets wijzigt de beheerder.

## Testen

13. `unittest` en `karrio test`, geen pytest. Op macOS heeft WeasyPrint GLib nodig, anders breekt elke Django-test bij de import: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib karrio test --failfast karrio.server.<module>.tests`. Een run boot ~25 s; bundel modules in één aanroep.
14. De Monta-connector is van de fork en staat in `plugins/monta/`, buiten `bin/run-sdk-tests`. Test hem apart met `python -m unittest discover -v plugins/monta/tests`, met `modules/sdk` en `plugins/monta` editable geïnstalleerd (zoals `monta-plugin-tests.yml`).
