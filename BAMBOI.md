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

## ClickUp en diagrammen (Leroy, 15 oktober 2026)

1. **Geen softwarewerk zonder ClickUp-taak.** Elke klus hoort bij een taak in de lijst Software (`901523279902`). Branch en PR-titel bevatten `CU-<taak-id>` (bijv. `fix/CU-1248uf3y8jk-annulering`). Nieuwe worktree: `bamboi clickup bind <taak-id>` (lokaal, geen token). Is er geen taak, stel er een voor en wacht op akkoord.
2. **De status in ClickUp klopt altijd.** Bij het begin van het werk zet je de taak op de status voor lopend werk; bij een geopende PR plaats je een comment met de PR-link; na een merge die jij zelf uitvoert zet je de taak op `testen` met de comment "gemerged"; bij een blokkade een comment met wat er ontbreekt en van wie. Via de ClickUp-MCP; zonder ClickUp-toegang meld je het in de chat, zodat een mens het doet.
3. **Comments zonder @mentions en met `notify_all=false`.** Taken van anderen alleen wijzigen met hun akkoord.
4. **Diagrammen blijven gelijk aan de code.** Raakt een wijziging een stroom, koppeling, datamodel of deploy-route die in een stack-diagram staat (`share.bamboi.eu/stack`, bronnen in `<werkmap>/.archify/`), werk het diagram in dezelfde klus bij: de bron aanpassen, `finalize` draaien, de HTML naar `share-bamboi/stack/<slug>/` en pushen (een push naar `main` in share-bamboi is direct live). Kan de sessie dat niet (geen Archify), noteer dan in de ClickUp-taak en in `HANDOFF.md`: "diagram nog bijwerken".

## Release en deploy

8. Na een merge in `main` bouwt `gh workflow run build-karrio-images.yml --repo Bamboi-tech/karrio --ref main` het server- en dashboard-image, met tag `<VERSION>-<sha7>` (`apps/api/karrio/server/VERSION`; de tag staat in de job-samenvatting).
9. Zet die tag als `karrio_tag` in `ansible/vars/staging.yaml` én `ansible/vars/production.yaml` (altijd dezelfde), in één commit `release: pin <tag> (<inhoud>)` op `main`. Daarna: `gh workflow run update-karrio.yml --repo Bamboi-tech/karrio --ref main -f env=staging`, controleren, dan `-f env=production`. Een deploy duurt ~12 minuten.
10. Gebruik de `karrio_tag`-input van `update-karrio.yml` niet voor productie: de pin in `production.yaml` is het record van wat er draait, en andere tooling leest hem.
11. Na een deploy is de API tot ~5 minuten onbereikbaar (502 via caddy of geen verbinding) terwijl `karrio migrate` en de static sync draaien: trage boot, geen crash-loop. Pas daarna is het een probleem.
12. **Secrets zijn gesplitst omdat de fork publiek is.** `GCP_GAR_KEY` kan alleen images pushen (build), `GCP_SA_KEY` alleen monitoring snoozen (deploy). Los een push-denied nooit op door `GCP_SA_KEY` ruimer te maken. De vault staat niet in git; de workflow schrijft hem uit de environment-secret `ANSIBLE_VAULT_ENV_FILE`. Secrets wijzigt de beheerder.

## Testen

13. `unittest` en `karrio test`, geen pytest. Op macOS heeft WeasyPrint GLib nodig, anders breekt elke Django-test bij de import: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib karrio test --failfast karrio.server.<module>.tests`. Een run boot ~25 s; bundel modules in één aanroep.
14. De Monta-connector is van de fork en staat in `plugins/monta/`, buiten `bin/run-sdk-tests`. Test hem apart met `python -m unittest discover -v plugins/monta/tests`, met `modules/sdk` en `plugins/monta` editable geïnstalleerd (zoals `monta-plugin-tests.yml`).
