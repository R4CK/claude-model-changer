# Claude Model Changer - Felhasznaloi utmutato

## Mi ez?

A Claude Model Changer egy Claude Code plugin, ami automatikusan a feladat komplexitasa alapjan valasztja ki a megfelelo modellt (haiku/sonnet/opus). Egyszerubb feladatokra olcsobb, gyorsabb modellt hasznal, bonyolultabbakra erosebbet.

## Telepites

```bash
node claude-modell-changer-install.js
```

Eltavolitas:
```bash
node claude-modell-changer-install.js --uninstall
```

Telepites utan **inditsd ujra a Claude Code-ot**.

## Hogyan mukodik?

Minden prompt elott a plugin automatikusan:

1. Elemzi a prompt komplexitasat (1-10 skala)
2. Felismeri a nyelvet (angol, magyar, nemet)
3. Kategorizalja a feladatot (28 kategoria)
4. Javasol egy modellt es routing modot

### Modellek es ponthatarok

| Pontszam | Szint    | Modell  | Peldak                                        |
|----------|----------|---------|-----------------------------------------------|
| 1-3      | Egyszeru | haiku   | Eliras javitas, atnevezes, formatazas, kerdes  |
| 4-7      | Kozepes  | sonnet  | Feature, bug fix, teszt, refaktor, komponens   |
| 8-10     | Osszetett| opus    | Architektura, rendszertervezes, migracio       |

### Routing modok

- **Auto-route** (score 1-2, 9-10): Automatikusan delegalja, nem kerdez
- **Borderline** (score 3-4, 7-8): Mindket opciot felkinali
- **Megerosites** (score 5-6): Javaslat megerositest ker

## Parancsok

| Parancs | Leiras |
|---------|--------|
| `/stats` | Hasznalati statisztika, modell-eloszlas, megtakaritas |
| `/configure` | Interaktiv beallitas varazslo |
| `/complexity <szoveg>` | Pontszam ellenorzes routing nelkul |
| `/route <modell> <feladat>` | Modell kenyszerites (haiku/sonnet/opus) |
| `/benchmark <prompt>` | Ugyanaz a prompt mind 3 modellel |
| `/dashboard` | HTML statisztika dashboard generalas |
| `/tune` | Override mintak elemzese, config javaslatok |
| `/rate <1-5>` | Utolso feladat minoseg ertekelese |
| `/save-pattern "<minta>" <modell>` | Prompt minta mentes auto-routinghoz |
| `/patterns` | Mentett mintak listazasa/torlese |
| `/export-config` | Konfiguracio exportalas |
| `/import-config <ut>` | Konfiguracio importalas |

## Manualis override

Barmely promptban hasznalhatod:

```
@opus tervezd ujra az autentikacios rendszert
@haiku javitsd az elirast a 3. sorban
@sonnet adj hozza egy uj gombot a formhoz
```

## Tobbnyelvuseg

Az angol az alapertelmezett nyelv — minden kulcsszo-kategoria eleve angolul van definialva.
Ezen felul a plugin automatikusan felismeri a **magyar** es **nemet** nyelvu promptokat is,
es a leforditott kulcsszavak alapjan ugyanugy kategorizalja oket:

```
fix typo in line 3       -> haiku (Typo fixes)          [angol]
implement new auth       -> sonnet (Feature addition)   [angol]
architect microservices  -> opus (Architecture)          [angol]

javitsd az elirast       -> haiku (Typo fixes)           [magyar]
implementald az uj API-t -> sonnet (Feature addition)    [magyar]
architektura tervezes    -> opus (Architecture)           [magyar]

Tippfehler beheben       -> haiku (Typo fixes)           [nemet]
implementiere Feature    -> sonnet (Feature addition)     [nemet]
```

Mind a 28 feladat-kategoria le van forditva magyarra es nemetre.

## Beallitasok

### Gyors beallitas: Preference profile

A `/configure` paranccsal valaszthatsz profilt:

- **cost-saver**: Tobb haiku hasznalatot preferalo (haiku 1-5, sonnet 6-8, opus 9-10)
- **balanced**: Kiegyensulyozott (haiku 1-3, sonnet 4-7, opus 8-10) - *alapertelmezett*
- **quality-first**: Minoseg-elso (haiku 1-2, sonnet 3-6, opus 7-10)

### Keyword influence mod

A `/configure` menun keresztul allithatod:

- **override** (alapertelmezett): Kulcsszo talalat felulirja a modell-valasztast
- **boost**: Kulcsszo +/-2 ponttal befolyasolja a score-t, de nem kenyszerit
- **none**: Kulcsszavak csak a sulyozott pontozasban szamitanak

### Tovabbi beallitasok

Szerkeszd a `config/task-routing.json` fajlt, vagy hasznald a `/configure` parancsot:

- **Safe mode**: Minden auto-routing letiltasa (teszteleshez)
- **Budget limit**: Napi/heti modell-hasznalatkorlatok
- **Context monitor**: Token-hasznalat becslese, automatikus modell-downgrade magas context-nel
- **Anomaly detection**: Figyelmeztetes szokatlan opus/koltseg spike eseten
- **Adaptive weights**: Pontszamitasi sulyok automatikus beallitasa minosegi ertekelesek alapjan
- **Prompt hints**: Modell-specifikus tippek a prompt vegehez
- **API rate limits**: RPM/TPM limitekhez igazodas

## Statisztika megjelenitese

Minden valasz vegen automatikusan megjelenik:

```
📊 haiku 67% ██████░░░░ | sonnet 33% ███░░░░░░░ | opus 0% ░░░░░░░░░░ | 3 prompts
🔋 Context ░░░░░░░░░░ 5% | Session ░░░░░░░░░░ 6% (47 left)
📈 Weekly: Haiku ████░░░░░░ 37% | Sonnet █░░░░░░░░░ 13% | Opus █░░░░░░░░░ 8%
📊 Total: ████████░░░░░░░░░░░░ 37% (74/200)
```

- **1. sor**: Session modell-eloszlas szazalekban
- **2. sor**: Context window telitettseg + session hatra
- **3. sor**: Heti modell-felhasznalasi aranyok
- **4. sor**: Osszes heti prompt vs. limit

## Context window vedelem

A plugin figyeli a context ablak telitettsegat:

- **55%**: Javasol `/compact`-ot
- **65%**: Erosebb figyelmeztes
- **75%**: Automatikusan letrehozza a handoff fajlt es compactot kenyszerit
- **90%**: Haiku-ra kenyszerit minden feladatot

## Fajlstruktura

```
claude-model-changer/
├── claude-modell-changer-install.js                    # Onallo telepito (node claude-modell-changer-install.js)
├── config/task-routing.json      # Fo konfiguracio (28 kategoria + beallitasok)
├── config/patterns.json          # Mentett prompt mintak
├── commands/                     # 13 slash parancs
├── scripts/analyze-complexity.js # Mag komplexitas motor
├── scripts/lib/                  # Modularis konyvtarak
├── agents/                       # haiku/sonnet/opus worker agentek
├── skills/model-router/          # Model router skill
├── hooks/hooks.json              # UserPromptSubmit + Stop hookok
└── logs/                         # Hasznalati naplo, session, status
```

## Hibaelharitas

- **Parancsok nem mukodnek**: Inditsd ujra a Claude Code-ot a telepites utan
- **Hook nem aktiv**: Ellenorizd `claude plugin list` — a status `enabled` legyen
- **Stats nem jelenik meg**: Ellenorizd, hogy a `CLAUDE.md` benne van a projekt gyokereben
- **Pontos context becslest szeretnel**: A becslés karakter-alapu, ~5-10% pontossaggal

## Tippek

1. Hasznald a `/rate` parancsot rendszeresen — 10+ ertekeles utan bekapcsol az adaptiv sulyozas
2. A `/tune` megmutatja, hol korrigaltad a plugin javaslatat — ez segit finomhangolni
3. A `/save-pattern` idealis ismetlodo feladatokhoz (pl. "deploy to prod" -> mindig opus)
4. Cost-saver profilban a legtobb feladat haiku-n fut, dramatikusan csokkentve a koltsegeket
