/**
 * NEET Smart Money Scanner — 24/7 GitHub Actions runner
 * Mirrors scoring & notification logic from neet-predict_2.html
 * Sends Telegram alerts when score >= 50 (or >= 35 for rockets)
 * Also monitors specific wallets for ANY buy activity
 * State persisted in scanner/state.json between runs
 *
 * UPDATED 2026-04-09:
 *   1. Removed stale hardcoded Telegram fallback token (it returned 401)
 *   2. sendTG now retries, logs loudly, and returns success/failure
 *   3. State is marked "notified" ONLY after a confirmed successful send
 *   4. Strict dedup: one alert per coin, ever (no more 4h cooldown re-alerts)
 *   5. Removed mc<=200K upper cap (was dropping tokens that pumped past it)
 *   6. fetchPairs() / checkWalletBuys() errors are now logged, not swallowed
 *   7. Watched-wallet signatures only marked seen after successful TG send
 *
 * UPDATED 2026-04-10:
 *   8. Added token-boosts/latest/v1 + pumpfun-grads.json as data sources
 *      so alerts fire as soon as tokens appear, not just when profiles update
 *   9. Age filter: skip pairs with pairCreatedAt > 48h ago
 *  10. Holder filter: skip if any single wallet holds > 8% of total supply
 *  11. MC upper cap restored: skip if MC >= $1M
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TG_TOKEN  = process.env.TG_TOKEN;   // REQUIRED — no fallback, fail loud
const TG_CHATID = process.env.TG_CHATID;  // REQUIRED
if (!TG_TOKEN || !TG_CHATID) {
  console.error('[FATAL] TG_TOKEN and TG_CHATID env vars are required.');
  console.error('        Set them as repo secrets: Settings → Secrets → Actions.');
  process.exit(1);
}

const STATE_FILE       = path.join(__dirname, 'state.json');
const SCORE_THRESHOLD  = 50;
const ROCKET_THRESHOLD = 35;
const SOLANA_RPC       = 'https://api.mainnet-beta.solana.com';
const WSOL             = 'So11111111111111111111111111111111111111112';

// Hard filters
const MC_MIN          = 5_000;
const MC_MAX          = 1_000_000;   // skip coins already over $1M
const VOL_MIN         = 0;
const LIQ_MIN         = 5_000;
const MAX_AGE_MS      = 48 * 3600 * 1000;  // 48 hours
const MAX_TOP_HOLDER  = 0.08;               // 8% max single holder

const SM_WALLETS = [
  {name:"180D Smart Trader [DpYuj2At]",addr:"DpYuj2At1Z1tH4baoz5A1XV4AanjJa8bgbB51BWSZUyn",score:99},
  {name:"180D Smart Trader [69SzLy86]",addr:"69SzLy86mUfdeFqYurR4YsvcTuvYsVAqwdeTGWiGvRgt",score:97},
  {name:"90D Smart Trader [3fupiyLE]",addr:"3fupiyLEr2BnFE9myQY8FS1kzqjhVZd7MdxUj74TFev4",score:97},
  {name:"Smart Trader [FMkNK3u7]",addr:"FMkNK3u7ZhS84hqxt9ETNSeC9w43RThiN6RvQJaSEhC8",score:88},
  {name:"Orange [2X4H5Y9C]",addr:"2X4H5Y9C4Fy6Pf3wpq8Q4gMvLcWvfrrwDv2bdR8AAwQv",score:94},
  {name:"Smart Trader [8q3vQtV9]",addr:"8q3vQtV9kuWdzzXVrweivhbKbZ5jXGq426fX4AhahZPX",score:92},
  {name:"90D Smart Trader [A2vZY74J]",addr:"A2vZY74JHBBwfjo3F1Bo5iiLXpABfAhmgdyfUGzABY9F",score:95},
  {name:"30D Smart Trader [D3MuDmrs]",addr:"D3MuDmrs2dm6U9CiZur651CnPjLwUWjs9p1a3PoDs76H",score:93},
  {name:"30D Smart Trader [HZrd9c6a]",addr:"HZrd9c6ag9hBtJhHQZvHeJHeZG8jYQQPVqq21U39GvyP",score:92},
  {name:"lesabre [4hfcN3bk]",addr:"4hfcN3bk5gCWNCrbowJBgFzvtPFCgf5bynR4bCBut7E3",score:92},
  {name:"logjam [5fkAwNVp]",addr:"5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c",score:98},
  {name:"180D Smart Trader [8q4HU6uH]",addr:"8q4HU6uHV9ViAkpjbdavnkM2njAPPq6h88P4rBHchb2F",score:91},
  {name:"richmax.sol [2HjBsjTC]",addr:"2HjBsjTCg9ZpWmU2KRtKDuF8ZUpQzWB16BK9ZzdFVgWL",score:91},
  {name:"90D Smart Trader [CoNcGfS9]",addr:"CoNcGfS9M4p56mJ2nqP35YS2y2X3mhvpu8AMgHbUniRC",score:84},
  {name:"180D Smart Trader [FcNAsyaG]",addr:"FcNAsyaGLQJWaADSWGFono2GHbtSv1iCJPbd9QGyUybF",score:86},
  {name:"30D Smart Trader [5aj3Hnjx]",addr:"5aj3Hnjx2G5NCwP7hgybHqNJmQLcRNNYVTKg9Hv9ez7F",score:92},
  {name:"30D Smart Trader [FvXiTcPA]",addr:"FvXiTcPAQCyUdZBFLhJBiYEAfyi79raezsure4qHMkgv",score:92},
  {name:"30D Smart Trader [4ToyC5XY]",addr:"4ToyC5XY9mTX4s9Qh1jSveaY1iZZDbAVgokxizUPXid9",score:89},
  {name:"90D Smart Trader [8UXcVkHY]",addr:"8UXcVkHYw4P2riBUAsfT9FUSRzWZgENQ8xJjXHQh3xGM",score:85},
  {name:"180D Smart Trader [CH8Agh6c]",addr:"CH8Agh6cnTWqFpkBJj88fpFnD59vTMdrrzcBBeXDJLeF",score:81},
  {name:"Mitch",addr:"4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t",score:96},
  {name:"Hugo Martingale",addr:"Au1GUWfcadx7jMzhsg6gHGUgViYJrnPfL1vbdqnvLK4i",score:95},
  {name:"👨‍⚕️ KayTheDoc",addr:"DYAn4XpAkN5mhiXkRB7dGq4Jadnx6XYgu8L5b3WGhbrt",score:80},
  {name:"👑 trey",addr:"6TEESe51iQyQRUvEuUGy3hVGpguqF34N9JUfNaURZVxK",score:80},
  {name:"👙 sophie goat",addr:"7E9jfxCczubz4FXkkVKzUMHXGwzJxyppC4m7y3ew8ATg",score:80},
  {name:"💔 Cabal",addr:"92ot9FuDS7xBA8xXJYMwE3q9vmAhh9ydg5htTgEZVeAv",score:80},
  {name:"🥥 Kev",addr:"43F989T2dxVeLNU6DHVyfeKjdXZm6Tq1EtAdfVsmZJ2a",score:80},
  {name:"🥥 Kevszn",addr:"CAsytuyXY49AzDZWqx1R5CAaRrpaeqTdPedt74xGw5kK",score:80},
  {name:"💯 crypto villain",addr:"5sNnKuWKUtZkdC1eFNyqz3XHpNoCRQ1D1DfHcNHMV7gn",score:80},
  {name:"👁️ hesi",addr:"FpD6n8gfoZNxyAN6QqNH4TFQdV9vZEgcv5W4H2YL8k4X",score:80},
  {name:"💢 bwam",addr:"bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa",score:80},
  {name:"🕖 Willy",addr:"777NtBUTG9tVu8Zp1YuuF3T2Hxi9cJzbbG67cHWi1aZ5",score:80},
  {name:"🤩 buga",addr:"HABhDh9zrzf8mA4SBo1yro8M6AirH2hZdLNPpuvMH6iA",score:80},
  {name:"👻 migratoor",addr:"A8Z1ejQGk45EJibBPJviWnM3UvwKSuYun53nSCkWKM52",score:80},
  {name:"🍄 jEE",addr:"54ZZWNRTqwLyaVH68MG8ZR8cfRU5Zppsny7DihVxmjEE",score:80},
  {name:"🍒 Tim",addr:"ARN1garjVGC4Ru2JnGsHdLaUQBbQhSXGAi5To3mdeJDz",score:80},
  {name:"💊 h69",addr:"6Xypz2cFJMkAwwkgYWjato4PrbbXZAgv1c4okKaPGHmw",score:80},
  {name:"👧 new gake",addr:"4Hq9UkSXjEwDZDBMAo9Lnri7VnbQCoomRAdrT6NGMh1c",score:80},
  {name:"💰 rich",addr:"richb5CkVbs5kX1MNneB93TcJLfN3AiABMGYz5hEzTz",score:80},
  {name:"🍩 chester",addr:"8NJ7Ujpji8uMF2675mqaTSEm2DCbfJA7fiRKtiaqkaLN",score:80},
  {name:"⭐ Juicyfruittyy",addr:"J4Dg2TAU889ySrMoNVHEUVwXmAPaNTxZsvJz6TvhrJW6",score:80},
  {name:"🕯️ Hi",addr:"7kouZSDLSieVUE7NGyJyRbEbaLGzEcSxVv7Ykmh9X1sS",score:80},
  {name:"🥥 Kev",addr:"4dEYoUoDXVvyKjAnBT2M9F4HQhj6bfJ8qFy6HEbBcEfd",score:80},
  {name:"🐷 omtad",addr:"EzT4zzdtYEmfkvd6WzA3UeUon2CaGeWZtfPpbopyqa1w",score:80},
  {name:"👻 Cabal",addr:"HufqVoEtA6gJrkTnDi9ZwdYozX4V5fXurZbb3tt3jLz4",score:80},
  {name:"🧧 PAIN2",addr:"HAN61KQbgzjDBC4RpZJ1ET8v32S4zdKAjoD7EApJ96q6",score:80},
  {name:"🍠 jellyjelly",addr:"4qMhJ42sCexUkXgqEkPt9nsyK93d92QeNGKZNyNYPGUb",score:80},
  {name:"👼 henn",addr:"FRbUNvGxYNC1eFngpn7AD3f14aKKTJVC6zSMtvj2dyCS",score:80},
  {name:"📲 TDN",addr:"65Xh9pNx4ujb2aWGs5kXPmDLXK3Dwo5McyLGEX9KtfME",score:80},
  {name:"🍃 leens",addr:"5pxkp8Rpg7xHekFf7URJ25i4P5ZXVk8hRQUaDKytU5K7",score:80},
  {name:"🐻 +837K",addr:"4xDDNggBJmahMqJAxZdRVLjs194C6z1XH6FBo3iAqRcv",score:80},
  {name:"🚢 porta pog",addr:"BN9bFo7Dh4zS22x3mr7NPQsJsxrMu7b44NbhXXAJZQ6S",score:80},
  {name:"🚢 porta pog",addr:"4NJ4Fj9wdqvDZUwbVtVjo7dP1HDv4wNc2Whb4rVFyXeX",score:80},
  {name:"🌪️ weaver",addr:"ANxp8yZiQeX5dGQaLsatwUHN6BZMS5sa95aLb47gwNyv",score:80},
  {name:"🫐 spuno",addr:"5cs7VtJtornbiTdjhgysN7C5GqV4Y1V1xyH1EQHNoDYc",score:80},
  {name:"🌇 Nyvo",addr:"93WHQxFvwT9ZHnD3vK5eqtFgJd7z6pGJCSuA7cg9hQqk",score:80},
  {name:"🌆 Nyvo",addr:"HdLytzXLHRUnPD3wMnp2KFvEDzWWQ6Rb7nqqzMKogASr",score:80},
  {name:"👻 criminal",addr:"BCquKNKmZ2uhngRFLdiS5px9XEdjiQCmQXD8M6Cd4xWP",score:80},
  {name:"🦦 Beezie",addr:"2LWhPiHagG6M1SyrX6STHhSY85dNm1k6wsapnKppjNZe",score:80},
  {name:"😄 copytrader",addr:"5W4sXjpeY6DVw3wXrHuf1qWGunwRCjeio7gKXhagB7BR",score:80},
  {name:"🍔 doordash",addr:"7BbYhLfW74zRHuxBKW2thtFspuWHYfXBuCqjHvGqpwp2",score:80},
  {name:"🚗 Bumper",addr:"DzJW1Kc8r3A2mgEjQ7Qxx6PgV976nPLDMeFPQJTcvUWn",score:80},
  {name:"💳 NPAY",addr:"4uFYTjbK86ZTACXyhQMvLZQH3BrrbnPmrcLbx7DYPDam",score:80},
  {name:"🚗 bumper",addr:"3jzSDHYGrt2iN9kbUbWkREZVjLJ9TSbEtNb7djY28T35",score:80},
  {name:"💯 OTT4",addr:"F9ENp6A75Qr1XR8FGNvEkGkG4GKwNtr1E2TiV5T3Lruj",score:80},
  {name:"💚 profitier",addr:"4pqD14u2Wd3MpNsC5tYQeNyJGigGGrcVBLEyjo1XZkxJ",score:80},
  {name:"👻 becker",addr:"7bqZMF2Dc5LspsQQeQgBdPKuy8oUm5uztQj9jVTcYXZv",score:80},
  {name:"✡️ Faze Megga",addr:"H31vEBxSJk1nQdUN11qZgZyhScyShhscKhvhZZU3dQoU",score:80},
  {name:"💔 pamper",addr:"D41BUzvz4W1y5oBQc3ui4adUdAZKEjj3iHuvGup1EZZv",score:80},
  {name:"💔 pamper",addr:"AssUhSvBEbN7pVvWqhn4BcCYz5bWRbJLkVSttpdBgNc7",score:80},
  {name:"👝 scharo",addr:"4sAUSQFdvWRBxR8UoLBYbw8CcXuwXWxnN8pXa4mtm5nU",score:80},
  {name:"☠️ mort",addr:"7McKpCN38mbVu6fzkve4bWTUQFxmVzRDsXH84jyZPpqX",score:80},
  {name:"🥷 nom",addr:"4ZjYSCH3Sib9iMSM3QN2sL2kwxNcXG2P4XCemSC2hsyb",score:80},
  {name:"💔 bands ps",addr:"ByawfdMmv5d5gUJUo8MdzngTF3GZbNbXxLG8YJo1wfn",score:80},
  {name:"⛑️ west",addr:"4L2v6MBtswTi91LNXNoxWc9SFn4eaerTpNsHGSqQCVZW",score:80},
  {name:"😃 copytrader ohK",addr:"GiF4hSkBiYgxJ9Rs2FVo8zJunNqpfLJEioL4KAwGtohK",score:80},
  {name:"😀 nolan",addr:"3K6NEUXqPj45tmoeSD135ffJ3eo6ouGV2onRWJZFpY3Q",score:80},
  {name:"👻 bnab",addr:"B8vnpRRkacuKKdS8tEDamSovXC2tPECheVSRcgNebnab",score:80},
  {name:"👻 dood rapist",addr:"9BsZN8E8a84Vvh2UFVJmovUNbbkFiGLABXJqbTf8vRiR",score:80},
  {name:"🪵 log",addr:"JAJADxeUZgLtV7kaeCsWW2tyGqZ2tpVa7ctdZsHFESFn",score:80},
  {name:"🪵 log",addr:"HAHAJhcY7xWsPVQpMUgnaRgi2uxWBxwhPuuGppr4qmLz",score:80},
  {name:"🧭 Time",addr:"TimeAdRpWxqKXR5YPEwGBF48KC5V5TxB2g6mnyCp4VR",score:80},
  {name:"👻 Eow",addr:"4x2uPAD4vR83MqHdvEYZYnpoZcZBa8fWUNPyGhoeKEow",score:80},
  {name:"👻 ykn",addr:"8mvfpiGG8dK5iYG49eyXZT1sVeJ1F12TpgmdubS49YKN",score:80},
  {name:"🦊 R4PE",addr:"6Eq4gQaaGX5NUKe8hp9FGRMFQkY237Homjar418pR4pe",score:80},
  {name:"🧬 xXx",addr:"xXxXZxyF6pik6YmTbNDwbYBErJUaRiaxjTJsUABos5G",score:80},
  {name:"⛓️ trav",addr:"CXnf4Tt7qFz3KZNwn3Yve5MKaRyxGoAy2eDX3QT8e99m",score:80},
  {name:"👀 baoskee",addr:"7FWR2NsCfQP66RTqww9xiSzb3r2jLa3DyiY1oif1oKPu",score:80},
  {name:"👻 kyz",addr:"CjNHcTyWYE1q1zX5GgpoPw53Lw5D1f4yUUmqNzd4sVxG",score:80},
  {name:"👜 scharo2",addr:"BQ6gHCvYsrSBB37sJvBGrbma1RXWJGdUj5ju3uXwCW82",score:80},
  {name:"🤔 terp",addr:"Hk~4P3PhRWHXoTFeuvkKEE4ab26xZ1bk6UmXV88Pwz",score:80},
  {name:"🥥 Kevszn",addr:"4fErksUdVqFSF9GSoqeapqvtZwm4YifWvWardJohLix7",score:80},
  {name:"🐸 earl pump sad",addr:"BK5bTK7mXPTEqdB8CYFwsw8pmjLWVJp127hxoTbSmEHz",score:80},
  {name:"👻 Created",addr:"B7Jibp8Y6Qot3hhJhmBonpMYnbTttHebw7fnsjG85yrU",score:80},
  {name:"🪵 log new",addr:"AA61V4Ry7Ud7SrKidKqMW1xTfUDsN	�F8R�mBmjYS7De",score:80},
  {name:"👻 shawl",addr:"DScqtGwFoDTme2Rzdjpdb2w7CtuKc6Z8KF7hMhbx8ugQ",score:80},
  {name:"🐒 Monki",addr:"53BnNc49Ajgstciq3CRoyxuBpkkW1r8pgPyvr7JGYnsh",score:80},
  {name:"💄 itai",addr:"HdxkiXqeN6qpK2YbG51W23QSWj3Yygc1eEk2zwmKJExp",score:80},
  {name:"☀️ lunar",addr:"6hHfDSagPQv4ouhr7x17jp9tQNfqUhdJWFHY5mEHnLp2",score:80},
  {name:"🌐 Yug1",addr:"AQ46kfYT3hW28Xg5gWHrJkzFSz1oGWBHC3FsTbqgMEco",score:80},
  {name:"🥏 dmt",addr:"HF2Lw2tYs4B3y1iqz6iw2f4wTjrn14KppvAezcm7TAT3",score:80},
  {name:"😨 Staticcs",addr:"GQetkDMK82cHYXZVqZgv7Lf5Bqo4V5KR8WASQM39x2Uc",score:80},
  {name:"🍊 Rename wallet",addr:"DaWrXYYFUbseEDXyHEGCxu2MSeSWkH6WK3eZfijL4z1n",score:80},
  {name:"🍊 orangie",addr:"FqrffkWrBX8yCazfECny1YiQhkBme2E39ThEab1cxKfz",score:80},
  {name:"🍊 orangie",addr:"BKFsedJTgNLYotumqtrfWPqU1rZkzNBwNVMSenf1KTNt",score:80},
  {name:"🍊 orangie",addr:"9ap4XSoATNGdxoeMKrcNWtboatrW2PpTedwWaneQTtMe",score:80},
  {name:"🧷 quant",addr:"GRamkEB3FuZeB7vzsP3VywiohRAttrjER5PxmHBGNtQi",score:80},
  {name:"🛬 vein",addr:"BtDaZUqHr2mKH5EYQCztuerHBuBEfQNYdquTDtEZp2Ym",score:80},
  {name:"👻 thesis",addr:"2cY7x8rVavyw4p7bDYLwctiCeaLqWvyU2xCsqfi4kgqc",score:80},
  {name:"👻 pump sad pablo",addr:"JEBy7VuMsCqZDdprhmUNjB1MHTmt5dUFDeMXytbhTLdR",score:80},
  {name:"🐦 x",addr:"CLu4FJzmJ4qDfs5aNc64tWQ5B7FUy52CUiA1EeYfftr4",score:80},
  {name:"💙 coinbase",addr:"HpabPRRCFbBKSuJr5PdkVvQc85FyxyTWkFM2obBRSvHT",score:80},
  {name:"👻 DEFAULT",addr:"HdjAyXGuEMnTBi9vmqb8ws83BpU3hAoyoici8XUy8QSH",score:80},
  {name:"⛑️ west",addr:"9AisNb7DJ58ueNC9DLZVx1JgpQ3P93gnvZzmwVef5dRs",score:80},
  {name:"⛑️ west",addr:"2j7aWjSxWsRjJrmaYjSmwzH26dDYv3hkvAc2aNhn8oLP",score:80},
  {name:"👂 yolo",addr:"B7PrsYQpCZwaMDh2nAKZnAxJKRww91aKtwKjPxWoUfpy",score:80},
  {name:"👂 yolo",addr:"G3yqtdtQjJ87ERLMApbwnEeCNzP9BcX6LrR84ut7Qgnw",score:80},
  {name:"🥥 kev",addr:"8ah1FdxvQufHRH4LQGoncUmNLc6Mfj7MwD4DM2pewoSH",score:80},
  {name:"👻 aia",addr:"3oB4kFkceZmmXPYZT9WJfTYvjkUBS4upr1ssWpV5aa1A",score:80},
  {name:"🚔 danny",addr:"3XoUvPJFZ21KeVQBWVDVJP7nQtQvDRvW5n2Mw3wnb5w8",score:80},
  {name:"👻 YourKai",addr:"kaiUXfbLaRkCXUd1bT4znGnRBvXqhHZnGcrEkXHvkai",score:80},
  {name:"🍒 a16z",addr:"a16ZRRPYzkCgED9ECcFd9vdrFzW775Z2DqmAEsSZDGE",score:80},
  {name:"🪂 j sol",addr:"J3WSVQdfyeTy5x5iTEV2bNXnzfoP2a5iT69jE6ZxZRyw",score:80},
  {name:"⭐ juciy",addr:"5GdBK4NkaC98cyTFKgjtGyn8kqrWTTxhy3zYMXB3vGZ4",score:80},
  {name:"⭐ juicyfruitty",addr:"CkaAt24iBsRmYLnx24MrKe8scrxYxzXDco5AQ2jCq79F",score:80},
  {name:"👑 trey",addr:"cfKTJqVCaTt8Z7h46bpNEbymU295GD2ZJ59xf7qAxuM",score:80},
  {name:"👑 trey",addr:"GobsYMqCk3VQUueH4VBKuEzbVko4X1PAAi8DSM2gSCSq",score:80},
  {name:"🍬 daniww",addr:"8NgSPEZcJBg78z78n4FejqtQZ4HzpWNXMMV7yJiU7PWf",score:80},
  {name:"🍬 daniww",addr:"AuPp4YTMTyqxYXQnHc5KUc6pUuCSsHQpBJhgnD45yqrf",score:80},
  {name:"🍬 daniww",addr:"G7mfcf5GbZezcBKqcDo5u16TSLARTVxTRSjXxDYbVnaq",score:80},
  {name:"🍟 AlxCooks2",addr:"37N7EeV3UDe1zZ4FwL6sJ4BF37WJ1f3wdttKkP1uKseE",score:80},
  {name:"🍟 AlxCooks2",addr:"Cs74tKou4YtUtRTv38t3k7sxYss6xFxUZbydiq4Un1qR",score:80},
  {name:"💔 87",addr:"cZDRUkxdmTUbUFoVDWeziUL6gfd9MNWGTd8THiN7Rnw",score:80},
  {name:"🍟 alx",addr:"7P6tp4KbxZpQrKFXRUbuW3VtDSp7AHAxAC5vYWa1QnBF",score:80},
  {name:"🍇 grapist",addr:"DXUDwz9Wu5sSiomqRYkpiB95MrBuxLDRYSNXvCPDnGCM",score:80},
  {name:"⏩ pedia2",addr:"8JLaADywkq9r9gUZtzu8NtZ5wpQXEHqjf8bnWSkyuiVN",score:80},
  {name:"👻 absol",addr:"HTM87R4mgjDdiF6Yfn8duK9vbDmZxiPCTRbGvm7eCAJY",score:80},
  {name:"🦹 kreo",addr:"8HeDT75s5g4CtCimH5B5nySqCiQhtWii8UnZhxBtFo38",score:80},
  {name:"⛑️ west",addr:"Dns5honDe4t792ihYDyQNAAPeWDweH6Na8ssxpQYGBT3",score:80},
  {name:"⛑️ west",addr:"4jfcYe53QjdceXbiJEAQx54n9dvoUZSn74fMvT84nnKX",score:80},
  {name:"🔪 Euris",addr:"FbUikugMfGzCMBmaZSbJrameK5MEBipe2uAsMW9u2jVx",score:80},
  {name:"🚰 jack duval",addr:"BAr5csYtpWoNpwhUjixX7ZPHXkUciFZzjBp9uNxZXJPh",score:80},
  {name:"😃 copy",addr:"C4iZV7FYFGXtwJxeF38UA1a5uKQv3vpANQWifKBZNuTe",score:80},
  {name:"🫐 spuno",addr:"4nUSJJXz32beKEHq5X6Hm8j3F8R27ARSoptFpkqcKw8q",score:80},
  {name:"🧟 oxstrategy",addr:"HYWo71Wk9PNDe5sBaRKazPnVyGnQDiwgXCFKvgAQ1ENp",score:80},
  {name:"😁 eeeeeee",addr:"eeeeAZZ8jNntdEWRdLgUfL7cDPeYePcD1r2udtTy5yX",score:80},
  {name:"🍵 Cupsey",addr:"2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f",score:80},
  {name:"🌟 juicyfruityy",addr:"cummwvz2iX8krGFsvd9FebNUBcaQr31rGHaqg9GRYsf",score:80},
  {name:"♠️ wiley",addr:"BsjftJFNzwfpT2kAQ2hURZUn9zFoqMQ93CsPLTYEFCUw",score:80},
  {name:"♠️ wiley",addr:"6EbQwK1bLmwwHPGYgUtGgH4PVA2Vq683SpmxauJXKC2m",score:80},
  {name:"⭐ Juicyfruityy",addr:"8paTPtvmEuZeZh2z3ct9YiKXig2xUdQt9N6Uf7cSWqih",score:80},
  {name:"🌟 juiCyfruitly",addr:"nuttbmvHLMzzTZxC8L8gVBobBtZpXcp9ALdM7yGomjM",score:80},
  {name:"😺 xander",addr:"B3wagQZiZU2hKa5pUCj6rrdhWsX3Q6WfTTnki9PjwzMh",score:80},
  {name:"👻 imera",addr:"3AHL1ipiAdbSC6SWUAexZQT7Tzs27dP14XFaf1JfZ55L",score:80},
  {name:"🕯️ CNDL",addr:"Dwjy8cPLeBZb33iaAFDfHeLkm4fmUJWCw6cLarkbYrx3",score:80},
  {name:"🖲️ RICO",addr:"HiTcw6obM5YAzDWdAzY5rJKh67QhVpKfNRjfDpBtDL3R",score:80},
  {name:"🍒 Rewards",addr:"D8QdouVi4bXVyYnFuhwGQXfymkM1XnRzgJZQPB3f4hLt",score:80},
  {name:"🌟 juicyfruityy",addr:"6HtCogegBXcEbcjiGMkeuCtvrvaiYD7keU7MLPYDHNHs",score:80},
  {name:"☁️ gasp",addr:"8MA4b2s2NJDwRwddutzvAouv2otfgjr9KY6HbGsnwDiT",score:80},
  {name:"👻 3sq",addr:"DBzwrJvpDDpUvxGyxHJdoNsswTViaGk5vdoKErr8Y3Sq",score:80},
  {name:"🐕‍🦺 morph",addr:"Hgqc79Kz4QoMBo6jrtvds22Hki98hAx4Rvj5oHRUbKZD",score:80},
  {name:"🐕‍🦺 morph",addr:"48kEQe5dRSqDn6paQPdeopghWDX3RAuWtb5EcgoatSa4",score:80},
  {name:"🍳 Cooker",addr:"8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6",score:80},
  {name:"🌥️ mercy",addr:"F5jWYuiDLTiaLYa54D88YbpXgEsA6NKHzWy4SN4bMYjt",score:80},
  {name:"👧🏽 Assasin.eth",addr:"6LChaYRYtEYjLEHhzo4HdEmgNwu2aia8CM8VhR9wn6n7",score:80},
  {name:"🕵🏻‍♂️ jidn",addr:"3h65MmPZksoKKyEpEjnWU2Yk2iYT5oZDNitGy5cTaxoE",score:80},
  {name:"💔 pump sad rlk",addr:"GEtFKDqzeTNTW2LtiAYL5ZV3ETwcv68nT9Qav97XaQkY",score:80},
  {name:"⚙️ revrevrev",addr:"EgzjRCbcdRiPc1bW52tcvGDnKDbQWCzQbUhDBszD2BZm",score:80},
  {name:"😀 xsv copytrader",addr:"3Z19SwGej4xwKh9eiHyx3eVWHjBDEgGHeqrKtmhNcxsv",score:80},
  {name:"👑 trey",addr:"BCT2mHG6V254zY5UFtsfKAduzcgJzSLZRRJxRcsGoby4",score:80},
  {name:"🔫 radiance fn",addr:"7eyDwQyps2hiLn1cCjqYzqKGWNBzE13rZp53VYYYUYeX",score:80},
  {name:"👑 trey",addr:"CbFxEVtevRBgFMyd7mRCScJENRvfECnApkRCHEX6Ef4Z",score:80},
  {name:"❣️ ROwdy",addr:"DKgvpfttzmJqZXdavDwTxwSVkajibjzJnN2FA99dyciK",score:80},
  {name:"💔 Q",addr:"gangJEP5geDHjPVRhDS5dTF5e6GtRvtNogMEEVs91RV",score:80},
  {name:"🍊 orangie",addr:"DuQabFqdC9eeBULVa7TTdZYxe8vK8ct5DZr4Xcf7docy",score:80},
  {name:"🌟 juicyfruity",addr:"6cFEC5gStPd5eakZDP3DzVyDT9KhJeqaYBa1WsBa1kyY",score:80},
  {name:"🌟 juicyfruitly",addr:"BeYkrDVFBXW4Ti4BSfspjeXJWxju9hKBtgL2Diy9krWJ",score:80},
  {name:"⭐ juicyfruity",addr:"C6gKw9VC9mc1KnzxKskATXZc3sNzLTsZpNfNJzKVaG4Y",score:80},
  {name:"🐼 Leck",addr:"2mGNGKYNGCNNz4EXrxz4TPckwGkiyGRNe447HncebYRg",score:80},
  {name:"📉 up",addr:"DYmsQudNqJyyDvq86XmzAvrU9T7xwfQEwh6gPQw9TPNF",score:80},
  {name:"👻 Pfq",addr:"ifCDsh7WDVn3UtgCSUP8Uo75LxFjyGHVxTDZ1wMXPfq",score:80},
  {name:"💔 Felix",addr:"3uz65G8e463MA5FxcSu1rTUyWRtrRLRZYskKtEHHj7qn",score:80},
  {name:"🌲 raze",addr:"8CLkTAHZt1joF4Swh7YKjGAA8qge1T1SZdoWJJsoGgys",score:80},
  {name:"♠️ wiley",addr:"67JSbyEMqJNNcBNzGukvhKRcArJ9qgXPcnyQUJPXNVvC",score:80},
  {name:"👻 H",addr:"24hUy7qdkBJT7y3i2ZnUzNTNggVBiPgchcvbXaRfeCL7",score:80},
  {name:"🧧 PA!N",addr:"J6TDXvarvpBdPXTaTU8eJbtso1PUCYKGkVtMKUUY8iEa",score:80},
  {name:"🦄 Yenni",addr:"5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG",score:80},
  {name:"💔 pump sad GM",addr:"947RGSg6aYnonnEforjVv8cVFHg2QJzPfHJiPmnnsEAL",score:80},
  {name:"🧨 good trencher",addr:"2zWtCEUXybiPEuSqayvnppiR3qXBT5mupMBG2qfMTF9K",score:80},
  {name:"🧑‍🍳 jerry cooks",addr:"4wG6KEyNR8WAeydHCDkeQYjFJtTBXQJgzyNTTNLqt1b1",score:80},
  {name:"⚔️ chukballs legion",addr:"CU35ZDB4JptaBVQWiq1gZsR8kso6dz1bQj8uR3xGn2kK",score:80},
  {name:"💨 CWF",addr:"CWFs2YvV5JSHdLecdgrBMGrQZ81dXdzMa6UWj4a8b9Yr",score:80},
  {name:"🤗 EYB",addr:"EYBJLQhCjyPhEBiZLAZN99qQqi53MX8SD9tndkTHj9JY",score:80},
  {name:"😎 alon",addr:"6DtEedWf9Wk5hA7Xth82Eq441yf5DA4aGLqaQAVfDokm",score:80},
  {name:"😀 smart dev",addr:"7BtwAHaXCki5BKFQz2fKQQAjmNWiq6JkmTS6GwTX5kfi",score:80},
  {name:"🖲️ ORB",addr:"CztkV1nTjdcboLYSDyNYvavksjavwxjVx2vgkBN1LKTm",score:80},
  {name:"🗻 SmokezXBT",addr:"5t9xBNuDdGTGpjaPTx6hKd7sdRJbvtKS8Mhq6qVbo8Qz",score:80},
  {name:"🎟️ aloh",addr:"xXpRSpAe1ajq4tJP78tS3X1AqNwJVQ4Vvb1Swg4hHQh",score:80},
  {name:"🌟 juicyfruitty",addr:"rapeBWSxw7AW4oxzmUEndNK1o6JAcUh2s1TJqMYiaqD",score:80},
  {name:"🤕 lonely",addr:"H4CbfVU4NWYkAgbCnsQscZxdBk6SEzEk8sac9Y8QoU2Q",score:80},
  {name:"🐦 pigeon",addr:"C8gWvcHV4AiFrMY2xi2ikjrBWD6P5rwzzwjMTVDM42xC",score:80},
  {name:"🔺 suppress",addr:"KYSGYZp17p7hGsoTJRB4ffy3dpu5M6Xi77YKvB9Z4hs",score:80},
  {name:"👻 criminal",addr:"ALiR2LoYLUAcU8NAeVFAuP1sUinQS9Cm5NaRKmpyupLj",score:80},
  {name:"👚 key",addr:"4Bdn33fA7LLZQuuXuFLSxtPWGAUnMBcreQHfh9MXuixe",score:80},
  {name:"👻 ani dev",addr:"Gj4s6v2LRLnhkDgZ7MAEU8VTgqygBFVJJh2odKNdGqWZ",score:80},
  {name:"👻 dust dev",addr:"4hyHStoAdFssn2rVmw8W84nu69qsuWvCA6WRw7avHB4T",score:80},
  {name:"♣️ slander",addr:"DR7ghPiRVBJ3YeP3FUJRuSa4XaWq4Pkw8ZM4JYs1PyJ9",score:80},
  {name:"💩 poopymcdink",addr:"EuC9bwq7AhtvgqhzFG5TtB2q8PYmgWbQ7Eei7FaC4oG3",score:80},
  {name:"😈 gengar",addr:"GH6qWg954466eqMJ5hU5Lt3dpjmuDCyBEMaL8vqrsu8b",score:80},
  {name:"⚓ CVNNOR",addr:"9bAHNiCf3s4N7m2pJzdvWXRDsk9eRkSSbaYVSzAVb9Dv",score:80},
  {name:"🛍️ Finn Bags",addr:"BTeqNydtKyDaSxQNRm8ByaUDPK3cpQ1FsXMtaF1Hfaom",score:80},
  {name:"🥌 rand cabal",addr:"D6B4C5KopAs3TPibLGN2qKDEPjiLmpWdZuZies81cfyC",score:80},
  {name:"❤️‍🔥 b2b-power",addr:"EjWBrhPapQzjKtNkCXg2j62wfqHpaF9zQYYPgJcBEGam",score:80},
  {name:"☠️ mort",addr:"AjiGHTZaj5iLGsDhwnLT5DVyGP1sc7mQGsVQt7kvvhpf",score:80},
  {name:"🔭 ozarke",addr:"DZAa55HwXgv5hStwaTEJGXZz1DhHejvpb7Yr762urXam",score:80},
  {name:"🥭 Bu6",addr:"Bu6PXhZoxGG7MMKdEMMK8ZSB3UCbU59sPbn8EqiQReY7",score:80},
  {name:"🧊 nyrhox",addr:"87MZqjjJgpuFvaU8GyQJKbZGnCFFhX82qAjBGLRXPfcn",score:80},
  {name:"💫 DEV",addr:"DiddyP7tSoS5e26zzy43QVfgTQ3dJ8ZyLibC3uPAAwQk",score:80},
  {name:"💦 chubs",addr:"AXgzGEvbgaFeb1xhdXkQc5D5CehZUa89ci2F9ugQPLaA",score:80},
  {name:"🥥 Kev2",addr:"EDY5ssvZEx6HHL5BjVs5NjJvc2BHib2pcynZ7v6eMCFZ",score:80},
  {name:"👻 te",addr:"8RrMaJXYwANd4zEskfPQuSYE35dTzaYtuwyKz3ewcZQx",score:80},
  {name:"🐩 EVE",addr:"EVEAppfhNZGjuxBPEyvr8x3bsdS4xUUw6YiPJyecM3gq",score:80},
  {name:"🌆 frank new",addr:"3JoVBiQEA2QKsq7TzW5ez5jVRtbbYgTNijoZzp5qgkr2",score:80},
  {name:"🪵 logFARM",addr:"FARMbpT39KzziHDRD3PQaih5Fdp2A6wxEx8Pk3wpqN2R",score:80},
  {name:"🤠 logan sleuth",addr:"685zCAGJ1hfasum3fU7YU19hJp4cU6d7jSZjQY1PfiQY",score:80},
  {name:"🌭 Realist",addr:"G9VPG4XvHheUUbzPexNzx9Yyx97ii53WYb89PvdM2qQk",score:80},
  {name:"🚩 s1mple do not buy",addr:"AeLaMjzxErZt4drbWVWvcxpVyo8p94xu5vrg41eZPFe3",score:80},
  {name:"🪐 cis dev",addr:"BwaVFCDJ4HfRfFWq1S23LHkk5VF4GKEw9oz7F1PxgcHv",score:80},
  {name:"✨ Wizard",addr:"4gMyDeCtXpUN91WUJuL8YH9hCDNd67FSQ6S8xZp3MjQe",score:80},
  {name:"🕯️ CNDL",addr:"AzLRkTZDN8XhtJ9owcdEwTjhk5utNVYcLxAcPvPyAQfT",score:80},
  {name:"🖲️ ORB",addr:"74kd7Z5LRLhXa17vxDwdELbaHb4h33L2XcYUAXZQcBa3",score:80},
  {name:"🐦 x",addr:"4qVQPBGkVZ611JhXqfKp8jm1zjC5SUtoNYAKwGz2VN48",score:80},
  {name:"🐸 earl pump sad",addr:"F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm",score:80},
  {name:"🏝️ brez",addr:"2jyzufCHXmQbhcfAsow84qPEhNRPfbFcfKfg6r6x9c1F",score:80},
  {name:"👻 JDEV",addr:"GpLjUnj5q8V6jkaaT7q26rQ4hzn7KYoebLRWfk16hTwh",score:80},
  {name:"🗺️ AMZ",addr:"4kkZuoaCU73CgTJPmXLjRBW5nC5Nf3Gi2yE52NCpk5wq",score:80},
  {name:"⭐️ s2 wallet",addr:"FgfzLpCJhHYZVji6Sw7omJDEdTq5C12FrV72HzDtwvb5",score:80},
  {name:"💰 Grandfnf2",addr:"FVxeFYgyT4GC6D7gaLkMSu2qtSJfw2N4RVPZowi2A64Y",score:80},
  {name:"🕙 Grandfnf1",addr:"DGPYpCdiVg2shab2TnNiZ2RnsjBQSmhgN71hJyWC5cYn",score:80},
  {name:"🤹‍♂ GorillaCap",addr:"DpNVrtA3ERfKzX4F8Pi2CVykdJJjoNxyY5QgoytAwD26",score:80},
  {name:"💔 pump sad GM",addr:"HvpYGTH6uqGia7x6v9ePBuY6mFEvpsJUgXPsqnJmfoRE",score:80},
  {name:"💯 ott4",addr:"G84Yz6fDA8wun3po1QG6SrGknK3cha2okXog9MmrqAQt",score:80},
  {name:"🍊 orangie huggy",addr:"H66T73iEqzZBrL4jP3sM7AmL1Be816nXysoS4KVxfP4t",score:80},
  {name:"🔪 Euris Rel",addr:"2QV7JLCg1rPpcyh3TyznvZ6q7qjBTpJEtmQska6iYVXp",score:80},
  {name:"🍊 orangie rel",addr:"ELSyW68qyAToytdaMkyQhgGL9FErGimoPA27AgingJtE",score:80},
  {name:"💔 pump sad h",addr:"AjoCbSQP6fz9wb8sUQT1wSnA7C14Rr1dvX7H5VHzxzJJ",score:80},
  {name:"👑 trey multi",addr:"5HjsA1SDFNjabGtH7peXnmdnQ4Fqbw8uxwqVwKqdj2FC",score:80},
  {name:"🕯️ CNDL",addr:"C2hfZGUsJiUpdFfz4chZrmK3KycBLkkfC8HGpvvf6QWV",score:80},
  {name:"🕯️ CNDL",addr:"84pnCqP8dGniC8aS8EN1PeqYZsRazHLBfAm3SWDrVNzP",score:80},
  {name:"🤔 motion wallet",addr:"FyNrn5ELHtimjCscVqRK11Q59VaH3knzahtcaPpcmSro",score:80},
  {name:"🔎 insdyer crypto",addr:"G3g1CKqKWSVEVURZDNMazDBv7YAhMNTjhJBVRTiKZygk",score:80},
  {name:"🪵 log",addr:"BATTp5ZA7gMmvzEhHQVCwpRQcpvKJmkscve1xbAdP6tE",score:80},
  {name:"⭐ Juicyfruityy",addr:"Azxhftx1pUhgM7U7MNyuUXMUuwVJeSnx7D2Qk6egScSc",score:80},
  {name:"⭐ Juicyfruityy",addr:"5XTpS9Ty5j8oAmP8G3YkiGJwT5NVSJkxB6W3ry9BLTxk",score:80},
  {name:"👧 gake",addr:"CNudZYFgpbT26fidsiNrWfHeGTBMMeVWqruZXsEkcUPc",score:80},
  {name:"🕳️ dust",addr:"FzVQSzj8JJr6WMGqbUHzx2XH1KkrfxRrRPv6WcbbZmND",score:80},
  {name:"🥕 slax",addr:"8b8KVQs22oUF21EyhFqKYK7MdEmsQ9ZuWL8yqvhGQg5P",score:80},
  {name:"🤓 roy lee",addr:"Dr7V12M5AcXAC2EEdzMHmwYwgUQbhUcT791szi5pzggw",score:80},
  {name:"👽 washy",addr:"GZVSEAajExLJEvACHHQcujBw7nJq98GWUEZtood9LM9b",score:80},
  {name:"🐼 Leck",addr:"LeckTHCG66D9CcZoecas8P8AGkNmqbXfAt6LXCKDWhq",score:80},
  {name:"👻 EliteFNF",addr:"GB1XcUJ6ddfAdjDHxztKxSieJnyvoVFVHSopDnLc7uWk",score:80},
  {name:"💔 degen guy",addr:"amen9NTHYuP5H1ZSbYKdyYYdHv8C48SxDdQ3qSCvSTJ",score:80},
  {name:"🌼 connor REO",addr:"9EyPAMyQvXaUWFxd2uQHvG8vpkKs33YdXvDvwmRXrUiH",score:80},
  {name:"👁️‍🗨️ hesi",addr:"EF5Bs9zmU7g4eqn79XiihZKdyVapM21Ap2q6qRN2rD8d",score:80},
  {name:"🥸 floppa",addr:"bozo8DPprqrU6N3y5cUDMDBCA61wGrk7qfy24Wm5rLB",score:80},
  {name:"🏀 profit",addr:"G5nxEXuFMfV74DSnsrSatqCW32F34XUnBeq3PfDS7w5E",score:80},
  {name:"⭐ Juicyfruityy",addr:"21wPp9nivRborUDJWALbWcxZRb4za1NyrtykyXgGdxFJ",score:80},
  {name:"👻 CPUTER",addr:"9cxJ3BgCdH57CHY2Fwti5JKJ9iKzEsbcp8zGcLeN294d",score:80},
  {name:"🐶 Kori Dev",addr:"8T9ychy4shZUYRu6LFjgNYDWPEQ14KEwyNXsr76fcNZy",score:80},
  {name:"🏀 WN1K",addr:"DoWxTJ9qgLr6hMpyr9zLXYvKv3MCkZUa77rNcwevWN1K",score:80},
  {name:"🌟 juicyfruity",addr:"8sADKnR6w2x7epgby9EeuDwgW1AUT9YbQyHDBEh84CD2",score:80},
  {name:"🌟 juicyfruitty",addr:"DwAZENiaTf3F7N2YW6oZxzNh6aQwT9DwytYFYz9HrrWm",score:80},
  {name:"🏹 send dev",addr:"26kw2x67UygLCqT9AQwZxNasnbtZdbENStDdrmyidQjC",score:80},
  {name:"⭐ juicyfruityy",addr:"DNsqWbXBqtQaGLmrVZ5H4ngscuWRgznnJALGjzFVEWH6",score:80},
  {name:"⭐ juicyfruityy",addr:"99EA4VHVZNimrjPTEj92yW7N3DMm5DM1uHncRmUpRLC6",score:80},
  {name:"🦴 maxi",addr:"Dj73eZmuEUAms1TrPeb9RUHotFCrtFCeu6BrQ6xrs3a6",score:80},
  {name:"🍏 meechie",addr:"9iaawVBEsFG35PSwd4PahwT8fYNQe9XYuRdWm872dUqY",score:80},
  {name:"🕵️‍♂️ jidn bundle",addr:"FFDiKhFxjWM6hxLfQduquj42idhwkHQobGHG88UFZwag",score:80},
  {name:"💔 Jerome",addr:"EZUBK7Qetzrwiop1yuX58HWeoRs1iHS74z3AH2p7VBTQ",score:80},
  {name:"🐡 oscar",addr:"AeLb2RpVwrqKZJ87PEiFdReiEXJXACQn17c8APQS1FHx",score:80},
  {name:"🧙🏻‍♂ 0xSevere",addr:"9FNz4MjPUmnJqTf6yEDbL1D4SsHVh7uA8zRHhR5K138r",score:80},
  {name:"🍊 orangie",addr:"26kZ9rg8Y5pd4j1tdT4cbT8BQRu5uDbXkaVs3L5QasHy",score:80},
  {name:"👛 Lunar",addr:"Cz99uWRvpCgsYTQDmK9YxiGcXoqsES1mFYnLMH3RM4Hf",score:80},
  {name:"🍒 pr6spr",addr:"sAdNbe1cKNMDqDsa4npB3TfL62T14uAo2MsUQfLvzLT",score:80},
  {name:"🥣 Nach Sol",addr:"9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz",score:80},
  {name:"💔 rlk pump sad",addr:"couhufai96amDSE9v2u4uLANTRG7z3TBx4gZg4sorry",score:80},
  {name:"🏎️ dubai",addr:"DuBaiGSB63mXR6KwJoNVG71eavXRJGknW5W3mQdZcg9i",score:80},
  {name:"♾️ Loopier",addr:"9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL",score:80},
  {name:"🥫 magus",addr:"EK5d8KojLGeS3ec5gByRXFEaXcYymQxxCERnMbJ9HSUA",score:80},
  {name:"🌘 Raz",addr:"RAZ9pxT3f3gVCs3jbYZPLHa293YqsA8LfsLx3VPs4so",score:80},
  {name:"💥 Gake",addr:"DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm",score:80},
  {name:"⭐️ Dev GFNF",addr:"3tc4BVAdzjr1JpeZu6NAjLHyp4kK3iic7TexMBYGJ4Xk",score:80},
  {name:"🔪 Euris",addr:"DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj",score:80},
  {name:"⭐️ Insentos GrandFNF",addr:"7SDs3PjT2mswKQ7Zo4FTucn9gJdtuW4jaacPA65BseHS",score:80},
  {name:"🐳 corleone",addr:"9HCTuTPEiQvkUtLmTZvK6uch4E3pDynwJTbNw6jLhp9z",score:80},
  {name:"✨ EXP",addr:"EKDDjxzJ39Bjkr47NiARGJDKFVxiiV9WNJ5XbtEhPEXP",score:80},
  {name:"🦆 Waddles",addr:"73LnJ7G9ffBDjEBGgJDdgvLUhD5APLonKrNiHsKDCw5B",score:80},
  {name:"⚠️ Til Multi",addr:"E6pP9QF5nJXUrZXbq6egk5j8i5FPNNttvQKbowvcWK6s",score:80},
  {name:"♠️ wiley",addr:"mp1V2SpFvcfJoyLPDNHLece3pYWBrmA97qco5GMMNP4",score:80},
  {name:"❤️‍🔥 flames",addr:"GiTjPLMYngDKZYxyc2MBFBwsS1Zt3NBCjJtAgsGb3AJv",score:80},
  {name:"🍊 orangie",addr:"2V54c75rjibgh6NsDWP88tbpu8KjQ3APRrK5zNQVqx1T",score:80},
  {name:"⚙️ lunalei dev",addr:"EnNEiTdV9g2Yau2pHipMvxjjrrMtkECG8Hj8a9WqXGzw",score:80},
  {name:"🐔 clukz",addr:"G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC",score:80},
  {name:"🚥 nitro",addr:"6WjJfqoRZuJdnf6m2xvRTyGp55yBiaJCZdZcYVbRUhKr",score:80},
  {name:"🦔 temu gake",addr:"76ZUBj1JLz7arTVHSRJok5oSTEqDuVBgySFMVHtzxzZc",score:80},
  {name:"🧑‍🌾 fuekfarm",addr:"D5FuekfarmjWjWNXivth5oHRU4YQFFAQHLmWbityo6Mm",score:80},
  {name:"👻 XwH",addr:"BhqDGPFnsDLXVjqeaUMXjohfFKNEmMbiXkBTrMRqeXwH",score:80},
  {name:"🌟 juicyfruity",addr:"EBw1HUnpWjj835UxyoN9HdAd9kLiEwWm6b9guCVmAYCt",score:80},
  {name:"🍔 doordash main",addr:"8tzURqBY6DpDFHPgzuZetjLfSVcoXeYnnSsAwszLkX1v",score:80},
  {name:"👻 criminal",addr:"F5XUMmh1oK3rtzBFVR5z5EbR2xnrijG5YKwgZxzx9gLk",score:80},
  {name:"🚗 bumper",addr:"6Dsj4yJK1EZcXDpw1ggcqzMxdFdbkbbTZf69AwZfGyD6",score:80},
  {name:"💧 Glorp",addr:"GLoRP4qQ4Mbs9Pks2mGRK84aUvt33RDRmsoXbkwKrGpo",score:80},
  {name:"🕯️ CNDL",addr:"6TRUWQ3qNhqDvi7eK7XyTkBpx6uU2VuudVDqB6cfT2Tv",score:80},
  {name:"💙 cb prime",addr:"EyYvbWSyDpYeVxS53t4AC1D5Jzn6TUwpCVLgEDxhxAQW",score:80},
  {name:"🥖 latuche",addr:"GJA1HEbxGnqBhBifH9uQauzXSB53to5rhDrzmKxhSU65",score:80},
  {name:"🌋 bronskee",addr:"BFXwqVGUDkwzMYZKv4Gr5QySSTGcitgyEXfSs7CybgUS",score:80},
  {name:"🪂 j sol",addr:"Dcomk8K3DqZgtL4EQx1bAuXpTYZPms2mfzwAjTT73ret",score:80},
  {name:"🥷 bandit",addr:"5B79fMkcFeRTiwm7ehsZsFiKsC7m7n1Bgv9yLxPp9q2X",score:80},
  {name:"🪖 good trencher",addr:"2F19ZXrvQDCoYXdBoFBiBcEmgrAKYAheZHnQxZksHQhN",score:80},
  {name:"🏳️‍🌈 theo pump sad",addr:"Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt",score:80},
  {name:"🌸 Blossom",addr:"62FZUSWPMX9pofoV1uWHMdzFJRjwMa1LHgh2zhdEB7Zj",score:80},
  {name:"🐶 Tim",addr:"AJ6MGExeK7FXmeKkKPmALjcdXVStXYokYNv9uVfDRtvo",score:80},
  {name:"📢 publix",addr:"86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD",score:80},
  {name:"🔌 caplug",addr:"6qKJ9nAdJWBtSwXACKuMmqQ1M1ySSv2XjGrFMofXZp5a",score:80},
  {name:"📛 braum",addr:"34caUhqLdLknMSGJqMYqh8DgkaUdNJwqTVPqiEPgRj4u",score:80},
  {name:"💔 pump sad dan",addr:"qNGhUruCGJpXJdsnV74USHErcbm3CrXRsnP8D6Z34Hh",score:80},
  {name:"🐼 leck",addr:"BEFo1bApSaFUKqhXq9Cc9M9We5evXkpH5zthVrBhSi7V",score:80},
  {name:"🌇 frank new",addr:"3URnnJKdG8eTjrKo7G8rN5GjzweYwSZSxwyJm5Ut5UmL",score:80},
  {name:"🎃 al4n",addr:"2YJbcB9G8wePrpVBcT31o8JEed6L3abgyCjt5qkJMymV",score:80},
  {name:"🐯 Kenzo",addr:"ECCKBDWX3MkEcf3bULbLBb9FvrEQLsmPMFTKFpvjzqgP",score:80},
  {name:"🫐 Spunosounds",addr:"GfXQesPe3Zuwg8JhAt6Cg8euJDTVx751enp9EQQmhzPH",score:80},
  {name:"⭐ til",addr:"EHg5YkU2SZBTvuT87rUsvxArGp3HLeye1fXaSDfuMyaf",score:80},
  {name:"🛁 Ferb",addr:"m7Kaas3Kd8FHLnCioSjCoSuVDReZ6FDNBVM6HTNYuF7",score:80},
  {name:"🎭 GIBBY/MOODENG",addr:"G1pRtSyKuWSjTqRDcazzKBDzqEF96i1xSURpiXj3yFcc",score:80},
  {name:"💦 5yk",addr:"5YkZmuaLhrPjFv4vtYE2mcR6J4JEXG1EARGh8YYFo8s4",score:80},
  {name:"🎲 Casino",addr:"8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR",score:80},
  {name:"🏦 BINANCE",addr:"5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",score:80},
  {name:"😰 Stxtics",addr:"4XMPyWFsYdNcCN4FG8geyytyTeUNacn4QundBzMqbGGT",score:80},
  {name:"❤️ RED",addr:"7ABz8qEFZTHPkovMDsmQkm64DZWN5wRtU7LEtD2ShkQ6",score:80},
  {name:"💸 FaZe Banks",addr:"CkxVhktjqYuhsVfNQzqEZkwQ2gMU1wEFPM3FSSVXGjM9",score:80},
  {name:"⛑️ west",addr:"JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN",score:80},
  {name:"💛 Dior",addr:"D2wBctC1K2mEtA17i8ZfdEubkiksiAH2j8F7ri3ec71V",score:80},
  {name:"🏁 kanyefnf",addr:"KANYEsXAntLxYUE6GtPJ5CahFGpEbaSbd5xhNFYbvq3",score:80},
  {name:"🎆 pow",addr:"8zFZHuSRuDpuAR7J6FzwyF3vKNx4CVW3DFHJerQhc7Zd",score:80},
  {name:"🍊 orangie",addr:"BiqkWhrJ4dfpE6TeNY34tA4GssG23SBH8CU8mqB7xZ6t",score:80},
  {name:"🍊 orangie",addr:"39qpCe9zdyC2g53UJeyGh5jwGBKjFwidCbnD5W53aVBW",score:80},
  {name:"🍊 orangie",addr:"CYqBuDDQEQBJb39uUZWTKoNEdMe9TYdtypkgFn8nDmsC",score:80},
  {name:"👻 ghostee",addr:"BD7oWkEQsUwE8sj4UT7jtrGjHC8Gq1iRqXY7U6DTbJpf",score:80},
  {name:"🧱 jalen",addr:"F72vY99ihQsYwqEDCfz7igKXA5me6vN2zqVsVUTpw6qL",score:80},
  {name:"🕷️ Chenz",addr:"9KAaPdrU2yNmsZoNogcWu22KhmrVdwy1rC438FxjjoSn",score:80},
  {name:"🍕 DAVE",addr:"5rkPDK4JnVAumgzeV2Zu8vjggMTtHdDtrsd5o9dhGZHD",score:80},
  {name:"🔳 absol",addr:"BXNiM7pqt9Ld3b2Hc8iT3mA5bSwoe9CRrtkSUs15SLWN",score:80},
  {name:"🦋 e_dev",addr:"BfUtyNtk82KsUe4rGpdYsTpywMUzYgY62yWuue5nFpi1",score:80},
  {name:"👑 king trey",addr:"831yhv67QpKqLBJjbmw2xoDUeeFHGUx8RnuRj9imeoEs",score:80},
  {name:"⚙️ rev",addr:"5TuiERc4X7EgZTxNmj8PHgzUAfNHZRLYHKp4DuiWevXv",score:80},
  {name:"🦹 Kreo",addr:"BCnqsPEtA1TkgednYEebRpkmwFRJDCjMQcKZMMtEdArc",score:80},
  {name:"👻 ghostee",addr:"2kv8X2a9bxnBM8NKLc6BBTX2z13GFNRL4oRotMUJRva9",score:80},
  {name:"🐦️ x",addr:"robotqKmKFEJkk8LjUcAsd7P4rxRodQXg7ycStWCMce",score:80},
  {name:"🥜 picasso",addr:"BjkpFFRG3NXfY3toyjpWqKPEV9S2RUsvPEJYW2YSrCCz",score:80},
  {name:"💔 essee pump sad",addr:"DTRUo2iFAKVf4hFmZaQT6ns7AqXXRawMUuEsV3gp3ktJ",score:80},
  {name:"💔 lunaei pump sad",addr:"6XEfkpHJXfu7jd7ZLG1Ngnou1vg7ZTNcM9fjVG5paCCW",score:80},
  {name:"🌪️ Weaver Mfnf",addr:"2itf6FWdZUqUb3fKUFPGnaTgqjjvWZwzrz129LCaqFa2",score:80},
  {name:"🔥 cented",addr:"CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o",score:80},
  {name:"🔪 Euris drippybruh",addr:"K27kZNq1P9a7A9HMSrkcwzLD7maN2S4VjhZW1ZSAvaG",score:80},
  {name:"💙 mini pow",addr:"HwAzzsi2NMirgRDs1LeUTLsPENgfL7pBss5ynEpwV7aY",score:80},
  {name:"🦇 Solcrow",addr:"ApRnQN2HkbCn7W2WWiT2FEKvuKJp9LugRyAE1a9Hdz1",score:80},
  {name:"🙈 Dan",addr:"J2B5fnm2DAAUAGa4EaegwQFoYaN6B5FerGA5sjtQoaGM",score:80},
  {name:"💔 pump sad esee",addr:"4uCT4g7YHH4xxfmfNfKUDenwGrRNGoZ9Ay1XFxfUGhQG",score:80},
  {name:"🗝️ lowkey",addr:"9ecRdqNCBxwReiY2pxtnLeayeBzE1CrSSmKKJJGdmsaJ",score:80},
  {name:"⚙️ witloof dev",addr:"5f8dDi7o8tGYkFVALB6VixhStULNDxxqNivgWEfr2z17",score:80},
  {name:"🐕 solporttom",addr:"42cfcPtPRHN6YQkWMzFhD9N67XWNZnAARYdMoR7RjsLX",score:80},
  {name:"🧽 zinc2",addr:"azwKsXexqXFbS3qu4vMCudqBuTdR8zmPpSTR5P1oc3P",score:80},
  {name:"🧖‍♂️ mrclassic",addr:"DsqRyTUh1R37asYcVf1KdX4CNnz5DKEFmnXvgT4NfTPE",score:80},
  {name:"🪖 Noodle",addr:"8CZjFG1EV3FduGV918QWUh7fevUoZSTffVY8bK6M3wbu",score:80},
  {name:"⭐ s2 wallet",addr:"2nNZ3i4GWFU35UyCEW3QX3VFfgaBGLd2M1z3tpGGCHQF",score:80},
  {name:"🍊 orangie",addr:"3EAAftccoF4zEeYviKXkNvRqqvzaCNtqQKvRxAkRvuXZ",score:80},
  {name:"📲 dv",addr:"BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd",score:80},
  {name:"🚔 danny",addr:"EaVboaPxFCYanjoNWdkxTbPvt57nhXGu5i6m9m6ZS2kK",score:80},
  {name:"🔌 og",addr:"215nhcAHjQQGgwpQSJQ7zR26etbjjtVdW74NLzwEgQjP",score:80},
  {name:"⌚ qt",addr:"7tiRXPM4wwBMRMYzmywRAE6jveS3gDbNyxgRrEoU6RLA",score:80},
  {name:"⚡ JS Shocked",addr:"6m5sW6EAPAHncxnzapi1ZVJNRb9RZHQ3Bj7FD84X9rAF",score:80},
  {name:"🟠 Orange",addr:"96sErVjEN7LNJ6Uvj63bdRWZxNuBngj56fnT9biHLKBf",score:80},
  {name:"🧑‍🍳 Jerry Cooks",addr:"HKjuMsz7JMuiQhkZsAwqogPf1KwhwACZGMcTmmtesoWv",score:80},
  {name:"⭐ juicyfruity",addr:"FaaYKNeYgphhp7WHP26Vc6bXPNqQdQqMvpv5kcHCAETk",score:80},
  {name:"📢 publix rel",addr:"BY6L98CXaQxzFAYt16qBPUuqyeCRXf5iWSr8SghzRTw9",score:80},
  {name:"🧙‍♂️ fomo",addr:"rp8ntGS7P2k3faTvsRSWxQLa3B68DetNbwe1GHLiTUK",score:80},
  {name:"💌 letterbomb",addr:"BtMBMPkoNbnLF9Xn552guQq528KKXcsNBNNBre3oaQtr",score:80},
  {name:"💔 stynx pump sad",addr:"2MDe4t6n29Fa9DkZMv2uZxdxbquDp4Jtros2oRQFfeU2",score:80},
  {name:"🦾 jijo",addr:"4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk",score:80},
  {name:"⚔️ grX",addr:"GrXjXop95XkVPYJafDJNCLFzK9K8LkpopxYcgUUn2H87",score:80},
  {name:"💔 pamper pump sad",addr:"Hgot6ZcPJFAfvVFi8EeqwmhUtrmH3MEoASz5bDLhWjza",score:80},
  {name:"🤍 pump sad Artour",addr:"AbS8pM7SMiUyNw6x9UieEBoMkamUmgTw2J1gPxQFnNFd",score:80},
  {name:"🃏 WaiterG",addr:"4cXnf2z85UiZ5cyKsPMEULq1yufAtpkatmX4j4DBZqj2",score:80},
  {name:"🐽 omtad",addr:"dATMod1UTXYzvaXji4mBsvXTeAUAC73TNJQAejKS54X",score:80},
  {name:"🌀 joji",addr:"525LueqAyZJueCoiisfWy6nyh4MTvmF4X9jSqi6efXJT",score:80},
  {name:"💔 pump sad daddy",addr:"daddyNgNXujDLijJ3xH9Zq1fXtywKqahvK7LiA2kDHX",score:80},
  {name:"💔 pump sad pablo",addr:"3BLjRcxWGtR7WRshJ3hL25U3RjWr5Ud98wMcczQqk4Ei",score:80},
  {name:"🐑 hauva",addr:"43FiZWbqc7DDTyhGpGSqQdbEokaDMuCy5nsFtv4P664Z",score:80},
  {name:"♠️ wiley",addr:"37yTBV9MbWEgS2gDhCBNV1qM4z6JtKNZawpa6V5BynY8",score:80},
  {name:"🔷 Fashr",addr:"719sfKUjiMThumTt2u39VMGn612BZyCcwbM5Pe8SqFYz",score:80},
  {name:"⚔️ Legion Wallet",addr:"CDmWZMEUAzJkaPstdvtNgyBzetHZ2kt1ProGDHoXgDCU",score:80},
  {name:"🧑‍🍳 jerry rel",addr:"4yh6vFcDRQ9kUkKbeaS9JcxiqkV3PosZEkUa586Fp6Uf",score:80},
  {name:"👽 axiom 1",addr:"AAdiaJy2As7g3bnL1nByMPij5wbZAhzVws6vC9VRs9gg",score:80},
  {name:"🍟 AlxCooks",addr:"89HbgWduLwoxcofWpmn1EiF9wEdpgkNDEyPjzZ72mkDi",score:80},
  {name:"🕵️ jidn bundle",addr:"99LhS8bV8te9ZU8cAorxQE2gtFtqegH88AtMNMx3aHSL",score:80},
  {name:"❦️ emteed",addr:"ArBhkg5rtNjEF5Dy2Jt1dHhKb68jB2f1dvrmjqy5LV3e",score:80},
  {name:"🔪 Euris 8av",addr:"8AVX6pqm9oE7pPrinccJ65EpquCDiDQ22rHwAPiGdPBM",score:80},
  {name:"🖨️ printer",addr:"Bu8iZsGvS5dwuY3GiEDjUSDayEME7LthH4x7TRGTnMXA",score:80},
  {name:"👻 huava",addr:"A3CZH8prYMnSqrxEfA7wHbCS5EC4riJ3w7meknDUHgyq",score:80},
  {name:"💔 qavec",addr:"CUkXcfgLsQcpCZNQzo9yGUEZ4PE2PVjuy8sTpu6aH3mV",score:80},
  {name:"🪵 log2",addr:"9bLyrKkpm2qSsUAZCkQqq4xtXu8e8M6j6gBvEZyhFMKV",score:80},
  {name:"🍒 FARM",addr:"FARMvM6h8YDmMvUKXiviWZDZygHhuGuDz9d1vDH8M2TL",score:80},
  {name:"🐻 +837K",addr:"7R3KWHxzCf1eevnqHh4YymyTf4WsVJRwVHjrTGiV5zq1",score:80},
  {name:"👻 old",addr:"Hn1RmiV69iHDqE6BueATQ2MmPbjZrEmjCuLzSXaSq51H",score:80},
  {name:"⚽ ronaldo",addr:"S2qyZ8wwnZgDFVb85ZSeAY6GAnH8iwa3vtzRR1n3CR7",score:80},
  {name:"👽 washy",addr:"D9gQ6RhKEpnobPBUdWY5bPQt2p3zGk3iVz6ChpUi2ArA",score:80},
  {name:"🐗 XBTPika",addr:"3btmjrS8jqQyysmf7w8hwrKvsEcqHc1HSDHiPJm9Zmap",score:80},
  {name:"👻 skely",addr:"973zBrSe9ujPTbvKpxeAb6DVPjmvRmJUUvwXrpxSTfeb",score:80},
  {name:"😀 Euris Copy",addr:"7GKcTj9wQfeFJja6okb5shMnGXYsTGFpcVSVPduX1y1r",score:80},
  {name:"🚔 danny",addr:"2GaSv3NQKWasZtrDStmpxegyzm6TZtMsYWSbxgtvLA1G",score:80},
  {name:"🪂 j sol FSH",addr:"777jiC5vZz3BUota4GrKToPjRYz5oxYJqigwKdXdgpwe",score:80},
  {name:"⭐ juicyfruitty",addr:"F4jsgr2bMhLemc6ZX2THhpvrYJh2kbcdNR34tQQX7RrQ",score:80},
  {name:"⭐ juicyfruityy",addr:"75yavMLKoyosj5oNMMzy3FkFie5ue94bzsmZFSwMACbd",score:80},
  {name:"👻 denzel",addr:"J8Vyp2pN8VQxPDeMqZ6QwRpQCjXqZ1wiW6ndTJmMsUar",score:80},
  {name:"🍊 orangie",addr:"7mgVhYzHGYY2CVXqWWx4KLPRjjpSeEVbDqeVk5qqE33h",score:80},
  {name:"🖕 GoFuckYourself",addr:"GfyP1QrdDR9T1T9mdF4YBzhkQdE3sCPsJPzost24Uvvs",score:80},
  {name:"👻 pamper",addr:"BuM4t6DkNUS8voRNDVTzjC5L46E9VE4JGNervjQY3DSz",score:80},
  {name:"🐒 Monki",addr:"GKHxVZQ8UbevjCB2xBZUkgecPDkReJdKmyjzsqHHDgX6",score:80},
  {name:"🥚 domy",addr:"rapeGQdKv1unJenbGYDH7Q7J7bGDxVYXXzhKLoMTKFw",score:80},
  {name:"🐲 dragon",addr:"9ha3rJRznYVzNkoJ5xyov3ZBjthrC8e8WNdjn48FQyDd",score:80},
  {name:"🍈 marcell",addr:"ATFRUwvyMh61w2Ab6AZxUyxsAfiiuG1RqL6iv3Vi9q2B",score:80},
  {name:"😺 Elizabeth",addr:"CU2U2xxiRKqoJvDWiyaGMkUqH56rhaHqD8kTd7X1Hu6U",score:80},
  {name:"👻 shah",addr:"2WN4rnEmB9c9ouC7VTb4CBXbyiY7qTMcvWUxKKQ2D47T",score:80},
  {name:"❣️ ROwdy",addr:"DQu6RDQpMCBn4ZZLL5Wdmn2FqjTu7d2yBTaA22K3xLdv",score:80},
  {name:"🐦 x",addr:"HECKePELevz7G8Vm247CNx4PyXpt6tmm9LtBYrDTG26u",score:80},
  {name:"🐦 x",addr:"5hQrMQitKo3Yj1k7NXkP2pZioNJtYQ51RXvowFfwVFwt",score:80},
  {name:"👻 7ds cabal",addr:"45WFz5zK54nE9yPenAHMgKf9A5esRrEVgEPBey2P56Sq",score:80},
  {name:"👻 7ds cabal",addr:"GTTS6p3MwsuddPpyKqL2sA15GM4CPMRa6o66gPoqYh71",score:80},
  {name:"🐦 x",addr:"GznY6R31XFuCsF3HGPNRcaahDZRh1FFYjSHZJnAts9U3",score:80},
  {name:"👻 7ds cabal",addr:"ACkvMCryf6XyAyZjUZomUHGGuL2eCTJLfCXgyJoCEVPR",score:80},
  {name:"🐦 x",addr:"45PmAoy2eoZ6voEkBr1ZGqi1dBJzjHTgYttbFfkwPyH9",score:80},
  {name:"👻 7ds cabal",addr:"4fwVuieSpMkRhuKvGAeZdAwADZ9XneTT8xhm6LLs6ND4",score:80},
  {name:"👻 7ds cabal",addr:"2LdjVMchpphiTAZHxGZE1Zt9PJEd1X3ZsXAeL9GFSLgo",score:80},
  {name:"🫐 Spuno",addr:"EcUvAMJk1q1umWbqVDCsuWeukCj7RCNCQRB84uS8arXV",score:80},
  {name:"🫐 Spuno",addr:"H2Y69ASWpu1r4b1frPsvn1ypuxQ2TiWf45vir2rp6cek",score:80},
  {name:"🫐 Spuno",addr:"CquHYbTn95ouAcXVRSiv27XdJX2PQnkrYd3deWzwHaYL",score:80},
  {name:"👁️ 0xTheEye",addr:"39KTKRTmg5YVS5b3nkGhzRVuEGhMcZcEGSPjENaHwePq",score:80},
  {name:"🆒 cooldev",addr:"5SW7p56x22LKj8gYcE8DVVd1S59UJUGR9jKq2PFdKiKg",score:80},
  {name:"😄 copy",addr:"2Nz4Fqp6mhhyV7aHbE93cxLWhuTPUxRMvZgF5qnWtkfb",score:80},
  {name:"🧓 old",addr:"CA4keXLtGJWBcsWivjtMFBghQ8pFsGRWFxLrRCtirzu5",score:80},
  {name:"🖕 liquidate him",addr:"7DFA5RUt2HNz6uNRvtJ56EoFUsRcLJDjNPgm5qqG6v8n",score:80},
  {name:"🍬 daniww",addr:"3v8mNVUrKsyRs2PUcoFfEY5of4zzRscahpkstGLgmGLS",score:80},
  {name:"🍬 daniww",addr:"BKWFf5zmw7PLmBZPUaHk8YXgZbZX5HHf7DT3LV6ViAJy",score:80},
  {name:"🍬 daniww",addr:"HLaRgbo8YrVfTh4Nn9MUU2o786RsJ86b4YSAbgjEfV9q",score:80},
  {name:"🍬 daniww",addr:"F1FE8k8cguYdzv3UeHgwao2AUgE8zPJzQvQKPiTfT14r",score:80},
  {name:"👼 henn",addr:"6gAgy3F1tLxeBWb8UhGEnmXYVRoaz3w1Lzv6APyhfoHk",score:80},
  {name:"💔 Bacardi",addr:"4ypAm2m9VfcCQr1WvKNLhkYcW9YgQeC6Xmvgjauwmzez",score:80},
  {name:"🌪️ weaver",addr:"D4Z3gesZ2aMT76qXecNKP8pT6ikJj43bjKmZpaGSFMSQ",score:80},
  {name:"😎 3asc (cluely)",addr:"3ascXfLsWrXe3F9MoQJjuigGH5w9evcaMhqPEjzCBTsr",score:80},
  {name:"🤓 nuno (cluely)",addr:"9RTva4wSk8E3EWYc8wtF9V94RUQGkemWtt3i8dUtsA4P",score:80},
  {name:"⚔️ grx",addr:"3N8mFvHeB5G9q3opXp3kCMEtKdpTT1azcBkxxtVUsJrM",score:80},
  {name:"☀️ elitefnf",addr:"9BsN4e6rycC5uN8JJY6QXEHo87ix7aLGs5bWyCeUMGdj",score:80},
  {name:"🥥 Kevszn",addr:"2A4R5NEjpcfTJCRJNh9iFoQuwxktjs8J7iHoLVS4CTSZ",score:80},
  {name:"🤟 bez",addr:"BEZPkD2ukDLjgMv4WtKp83qmuFcdhPQmeqif93eQqwp3",score:80},
  {name:"🤟 bez",addr:"BEZPVEj8H4czHGSKpdmWbYM7VqCPSH5EHwwNkyc9uZZB",score:80},
  {name:"👻 himgaj",addr:"DxjmHXm1p7cs8Tezdf2EJm5xnwp9QC2E8CbfD1aXeH1j",score:80},
  {name:"🦆 waddles",addr:"Ewn4p1M6RHrb7NRQRnK9kfmTzqc1g5x9NhuTvhwu7i94",score:80},
  {name:"👻 zander",addr:"C7tSBnqG4tztwEFCjfvFvGhdyaRigWNMuPk6sj88yUwE",score:80},
  {name:"👾 TheBeanMan",addr:"FTiSjJYi6aQaE7J4Z8N8m24maYerfPppU5LGzAkmGGKY",score:80},
  {name:"💩 blixze",addr:"5vg7he5HibvsAW86wfiuP6jw7VwKmUAnP6P93mVCdpJu",score:80},
  {name:"🚦 nitro",addr:"9hTfnPgW2fc5dfBjK6cxkXmuQma6XYoutnydBzJtDf8v",score:80},
  {name:"👻 huge anus",addr:"Aqje5DsN4u2PHmQxGF9PKfpsDGwQRCBhWeLKHCFhSMXk",score:80},
  {name:"🥥 kev main",addr:"BTf4A2exGK9BCVDNzy65b9dUzXgMqB4weVkvTMFQsadd",score:80},
  {name:"🇲🇭 good dev",addr:"4dnWLzmdkLeuDe6hwRBpPqrDbQZ59hpoBu8JLztAescf",score:80},
  {name:"💯 otta",addr:"As7HjL7dzzvbRbaD3WCun47robib2kmAKRXMvjHkSMB5",score:80},
  {name:"⏰ China Wallet",addr:"286CHN57Km41GsAnDv866WKd6YB6HPSjFgF4rGDJTRLf",score:80},
  {name:"🪵 log",addr:"2pUUZYtokRgDV2YzL6M5pjb1jyoHE367yU1sdQ7ac3ea",score:80},
  {name:"💩 fart coin dev",addr:"HyYNVYmnFmi87NsQqWzLJhUTPBKQUfgfhdbBa554nMFF",score:80},
  {name:"👂 yolo",addr:"Av3xWHJ5EsoLZag6pr7LKbrGgLRTaykXomDD5kBhL9YQ",score:80},
  {name:"⚔️ legion wallet 1",addr:"2rmJhgCfqWsh8MqUFchUnsv43EDg55mTh9bkYMT4oPHk",score:80},
  {name:"👻 yolo",addr:"8dwubKnL4FmmZsFt9cobpneFWH5azwRqDvciT2vsuQxS",score:80},
  {name:"👻 yolo",addr:"8FjipgAr2qxD7hVVkidEmTodNa1pCv1eMEFHk7TbJmED",score:80},
  {name:"👤 theo",addr:"mercyjp6vpa75nLGdz2jsTSp1qd9DiUQbMfT3i2QP8v",score:80},
  {name:"💖 ily",addr:"5XVKfruE4Zzeoz3aqBQfFMb5aSscY5nSyc6VwtQwNiid",score:80},
  {name:"👻 denza",addr:"CkjEpxsd4Lz1mftFMwuYsdd1MjFXYmmakQzaSvguTu5G",score:80},
  {name:"🐷 omtad",addr:"8tm6AhQHf9CcpdLs9swLM3DciL1xNsFmB4XqDXJFz4vY",score:80},
  {name:"⛑️ west",addr:"4QPHi1odW4kivqEFvW26Ej4vkKJhUnY3ZusV9wGGVqXk",score:80},
  {name:"🐙 kadenox",addr:"B32QbbdDAyhvUQzjcaM5j6ZVKwjCxAwGH5Xgvb9SJqnC",score:80},
  {name:"🐲 Dragon",addr:"6SYhd67FqypKyNqd5iFikRhrmKAKcCwwurSYUAMNSH4r",score:80},
  {name:"👻 useless dev",addr:"ArfVe1K5gt5zsxzRCWSQeWc1rJSJjZzuuYxmvRh71mMQ",score:80},
  {name:"🛳️ sleuth",addr:"DXqdaHjmZDELCDtjMNRYsC51roa7WtN3LrZQKheeCphV",score:80},
  {name:"🕦 9TJ",addr:"YRfr7z6NzEpbpMmup2ESwWD7g9Zbs378r9M8tTtR9Tj",score:80},
  {name:"⚙️ rev",addr:"Fiv89SifFZEaBcmAeiT2zkZCPkLJMrhdeVEi8NcbRGkX",score:80},
  {name:"💔 g1ock",addr:"g1ockF6dF3MU9oiKrqhPTSP6cMCWfC5mYLcHkaMERT4",score:80},
  {name:"💊 lexapro",addr:"8yJFWmVTQq69p6VJxGwpzW7ii7c5J9GRAtHCNMMQPydj",score:80},
  {name:"🏮 ivan HonorFNF",addr:"45yBcpnzFTqLYQJtjxsa1DdZkgrTYponCg6yLQ6LQPu6",score:80},
  {name:"🍈 Zrool",addr:"99i9uVA7Q56bY22ajKKUfTZTgTeP5yCtVGsrG9J4pDYQ",score:80},
  {name:"💸 faze trench",addr:"BC8yiFFQWFEKrEEj75zYsuK3ZDCfv6QEeMRif9oZZ9TW",score:80},
  {name:"👃 Noot",addr:"NootfpGs8pUWw9AotmLnxLPoii562HFzCL2Vd36RrE1",score:80},
  {name:"🍴 Euris Dev",addr:"3zv9Neg7Vdyj8HGzP7Mi2j9KvDdVL9Yq7gVdvxK1V6XR",score:80},
  {name:"💔 pamper",addr:"ASjhbYr3hpkUJ1vtA6BUnzNDKdrqkd1McYspF6XP6XL1",score:80},
  {name:"☀️ lunar main",addr:"GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5",score:80},
  {name:"👻 only up",addr:"on1yUpq8wmKxFoW1Arnu7G4xwm6T9yJ8dHwyHDfkiKS",score:80},
  {name:"🪨 Meteora Quant",addr:"AFf2m58fLB5JGpZqcWT5FY3Gw3YckAAYXWob8puTt1pt",score:80},
  {name:"⚔️ pullupso",addr:"GqZqcWNBmn73dQRaybFJUbWXPBtNer9KisArtf8hLTNH",score:80},
  {name:"🐺 coyote",addr:"A4DCAjDwkq5jYhNoZ5Xn2NbkTLimARkerVv81w2dhXgL",score:80},
  {name:"💿 Cxltures",addr:"3ZtwP8peTwTfLUF1rgUQgUxwyeHCxfmoELXghQzKqnAJ",score:80},
  {name:"🖌️ Art Bundle",addr:"AE4HLvqFGtkTKHjWzoBhTRRNPEasz12PdotBFUt2yaVx",score:80},
  {name:"🖌️ Art Bundle",addr:"CuLLLGaVnttw9Dc6B8ZKCbxnHmGZn6r6iHqxHBL7y3cS",score:80},
  {name:"🧧 suppress",addr:"cumV7jbJLfwuzknZHNKJFULdBVWsXj1MMgXm4SkpdQr",score:80},
  {name:"🪀 gurra",addr:"9P9aAh3kdMK651CcDG4iCdoByYj1FJgKq3yVoPrXVCAu",score:80},
  {name:"🔫 radiance fn",addr:"FAicXNV5FVqtfbpn4Zccs71XcfGeyxBSGbqLDyDJZjke",score:80},
  {name:"🪵 log",addr:"2toRw8MJ3YNVz1xGSXPzP2PBajNWG7YFnLZc1ymrDe5H",score:80},
  {name:"🪴 bepis",addr:"HL3FZ8XWnLnn1HuktmgpNRyFRjuAxWbXNQVj5fPPzZwt",score:80},
  {name:"🙄 Ethan",addr:"FUahwafcrQAmYKbtbj64QHBxdkZXhtitgxhNVv7wFkgf",score:80},
  {name:"🍿 awkchan",addr:"3LYtEmYerFPeXgu1c9Y4553oMk2qVdcxiwWzDjzMkwPx",score:80},
  {name:"🧶 ke3d",addr:"2XnxsF2jeRcuCoPY6BUva67itswoUauqFibCQuhKcwGh",score:80},
  {name:"👻 DOGE",addr:"56ccEEKRNHL5Ju9nkinFa5kF68WWGUro4nBWeBFwFWBT",score:80},
  {name:"😎 alon",addr:"3vkpy5YHqnqJTnA5doWTpcgKyZiYsaXYzYM9wm8s3WTi",score:80},
  {name:"🙈 lucas",addr:"FkzekjMLgbXC8NuSQQ2u53rmdh3jhfAZr2psDouDYvfR",score:80},
  {name:"📔 slidrrz",addr:"ACTbvbNm5qTLuofNRPxFPMtHAAtdH1CtzhCZatYHy831",score:80},
  {name:"🪐 based jup dev",addr:"4kguEV9YRtxuMiUJicpiUQ1itMxosEba4BHCfUTZJP3H",score:80},
  {name:"👻 trump dev",addr:"DJTwSyW7woa2N3Nt3L3S77Ef1GS4TfcJsYF5Qm3zcf1k",score:80},
  {name:"🫂 theo",addr:"Gake1z6f5jN4EkeWCqhC1BPCc1FrsstpbYB5SJcV4aEm",score:80},
  {name:"👻 yo",addr:"EqeB92fxcocvZesSWpHzawtso4nX5nYMFBJXY9kSiVD3",score:80},
  {name:"🧲 mayhem agent",addr:"Gygj9QQby4j2jryqyqBHvLP7ctv2SaANgh4sCb69BUPA",score:80},
  {name:"🍎 orangie 1k",addr:"FqPaw43zce12cuVmTX6wfZk545UbP4snuQW6Xosc8QQ8",score:80},
  {name:"🍿 awkchan",addr:"HAtawFqWtc3CGELWzituM8pg3P8fANejceTBjQKsCrck",score:80},
  {name:"🍿 awkchan",addr:"AcpFWXk7hf5RLS3Ee7QDUZrcTATN6R9tEr9j4BEwyYFc",score:80},
  {name:"💣 Keanu",addr:"Ez2jp3rwXUbaTx7XwiHGaWVgTPFdzJoSg8TopqbxfaJN",score:80},
  {name:"💣 Keanu",addr:"GMKNH8xEAfpMzk4oChsv3iLv6mAw8ksZQd6tbvLMuvLr",score:80},
  {name:"🖌️ Art",addr:"CgaA9a1JwAXJyfHuvZ7VW8YfTVRkdiT5mjBBSKcg7Rz5",score:80},
  {name:"🚦 nitro",addr:"H3U2xEw6pNunJZPAxrdXxqBzB4UZdpoymSp6YJ5o246N",score:80},
  {name:"💣 Keanu",addr:"8i5U2uNBEuTc4zskYP14zbebDg2RSwrrG8REhEnJb97K",score:80},
  {name:"🍎 Topblaster",addr:"2ihaWVuEe9ed2pVidqgKBCnKix88BYr7xfzRSDWUgTC1",score:80},
  {name:"🎟️ alohdev",addr:"buUDD73DW812WofBM5eHhXKMj9jnqmMYMi6eeHKm1UZ",score:80},
  {name:"🐶 BES",addr:"BESavbxMyMUVNZT8fBFdDxF4bKSzK2mevvsjxXQyCfyX",score:80},
  {name:"🐶 ELV",addr:"ELVGc3WUDPhNNBoH6TirKFUe4fuFHRxeBAQRyjK6NZq2",score:80},
  {name:"📇 dex",addr:"mW4PZB45isHmnjGkLpJvjKBzVS5NXzTJ8UDyug4gTsM",score:80},
  {name:"🐼 Leck",addr:"98T65wcMEjoNLDTJszBHGZEX75QRe8QaANXokv4yw3Mp",score:80},
  {name:"😀",addr:"G6bFfeb1Vn8BF3Vb8x6MrJeV6moLmb1FEy1Z5AihwMe2",score:80},
  {name:"👜 scharo2",addr:"GP25SFBKRQJM7tYHn7JkZ4m9eE8SFXzfSNwyWtUBeLjp",score:80},
  {name:"👜 scharo2",addr:"Dmaubz6YGkGezk5nL7rifevdUGLRTfjzAu74s1EujwE6",score:80},
  {name:"🫘 beanz",addr:"VJSDW6S74YXR4rRR9P4xwhMvLZJQMhrUb8XMFirUsy1",score:80},
  {name:"🪬 h14",addr:"BJXjRq566xt66pcxCmCMLPSuNxyUpPNBdJGP56S7fMda",score:80},
  {name:"🗯️ gasp",addr:"xyzfhxfy8NhfeNG3Um3WaUvFXzNuHkrhrZMD8dsStB6",score:80},
  {name:"🐊 gr3g",addr:"J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA",score:80},
  {name:"😨 Stxtics",addr:"DbcM7jJHMG8D68CrfJk86mkX1ntQXKgXawKf2waKYFny",score:80},
  {name:"👻 pippindev",addr:"DCj2TAjbSujcdPNVzBAx7fguaufpqwoWTmiAGNUc5Ywg",score:80},
  {name:"🐻 TeddyDEV",addr:"3mjHNqaPGVYncmd95w9TC3XGQe3EwGykGZiDQyhDxwhU",score:80},
  {name:"🐻 Teddyxroo",addr:"2Agm5qepq5GhdnsUQWAb5JEpF5rXp53eMjFePZNrugga",score:80},
  {name:"🐻 Teddyxroo",addr:"EPSKF5xTHSzihBKDdBRV2oWFDqaN5LWZ76x65YzdDHyD",score:80},
  {name:"🐶 Tim3",addr:"8ACcmVGPWzcvcJtgxyNZW8V1FyoNH4MuV3v8vNjDTF3t",score:80},
  {name:"🐶 Tim4",addr:"2oQUhfbW5rDjNBT9t6d1EHjqhSVWVG5QWgPzfSJtNhRF",score:80},
  {name:"🐶 mars",addr:"marsH3rLdpyEWfeXB2vvVj3jckfAQ1kv4BYFhsvLx2Q",score:80},
  {name:"🐶 tim6",addr:"4aXk1EXKSHxa6yqDtWmngLsyYCnvMXSQoKisddyempCn",score:80},
  {name:"⏰ ChinaAlt",addr:"2JhxVredAL2PN8oigPt5dpUStyZFtabAVnhmCQRi2QTh",score:80},
  {name:"🌻 connor REO",addr:"8eGqytw6HWhykdBoA9gNWZv7t7vYr6X8KeoDABU1731y",score:80},
  {name:"🌻 connor REO",addr:"7q5MVnzDoLnmLQvmWkKp282eZjSdUcUwWigxatBpnGUr",score:80},
  {name:"🌻 connor REO",addr:"2oCAmywXizFf2ECL5RzfNPbRUFByrsMRQWJQG1WxGnWu",score:80},
  {name:"⛑️ west",addr:"8ETArCvEyh8wnGkhtZ3AxeifAgGKxFRBsWQurzD3o1WV",score:80},
  {name:"💛 Dior2",addr:"CivnsviFr4zwAeG4UTsbzc77t5vKzzQtuZzddTvbtWdA",score:80},
  {name:"🧚 aiwass.sol",addr:"BZmxuXQ68QeZABbDFSzveHyrXCv5EG6Ut1ATw5qZgm2Q",score:80},
  {name:"🐦 pgeon",addr:"C6qpsGQTAurU9dFTVWVrhpqKfnvDWzHCNSZn8QKDAjRt",score:80},
  {name:"💼 scharo3",addr:"6vzubRoM5MrU9u6bZbxLTwwq62D3VsF8qqMZBqgG5GuD",score:80},
  {name:"🏀 giann",addr:"GNrmKZCxYyNiSUsjduwwPJzhed3LATjciiKVuSGrsHEC",score:80},
  {name:"🧠 Haider",addr:"Haid9XbugV4KWLD8ubmAV9iiM7NoUkb3FKU3cXCHRt6",score:80},
  {name:"🦆 Daumen",addr:"8MaVa9kdt3NW4Q5HyNAm1X5LbR8PQRVDc1W8NMVK88D5",score:80},
  {name:"🦛 diego",addr:"6ikUcjdzfkdFdsc7o5DXTLpsQLfymeFaajGemAaBGPnx",score:80},
  {name:"🔱 kryptix",addr:"AiLwAtCzPnQh6GnJ1UiMi9vqNniV3QyTM4rueKYNjPwN",score:80},
  {name:"🚰 jack duval",addr:"6Eegkyd2qNzxSzZz3PH3jiDyqL5HFcHdcsb9zfMzWHKB",score:80},
  {name:"😀 spanish dev",addr:"CC9w5c2wUx6d8b68KywEe9jcNNsCv4S8zhRqNPcAc9Fb",score:80},
  {name:"💛 Dior",addr:"87rRdssFiTJKY4MGARa4G5vQ31hmR7MxSmhzeaJ5AAxJ",score:80},
  {name:"🧬 Miki",addr:"XXXXXahGswEH6i3Czn19XbGxQrobJoY1TYJegPxp3ex",score:80},
  {name:"🙉 jerry",addr:"E33jP6RWVpGkv3fDVbuR5Ee6ak42tTKW9yYszqERtobs",score:80},
  {name:"💛 JDZ",addr:"JDZdFTTRewfCkux4CarYhgsM2vtUJfbfkEeQEHZXtpss",score:80},
  {name:"🇨🇳 david china quant",addr:"J485YzQjuJPLYoFEYjrjxd7NAoLHTiyUU63JwK7kLxRr",score:80},
  {name:"🦷 bier",addr:"E4Ruedde4i3tAfXu3sSojAanaHW1b6epsfdXRLbadv5S",score:80},
  {name:"🇯🇵 114514",addr:"HtpCoSsZmCkLgu5DdRC2GkNmioXDLLuDrxNHcBHaCTvQ",score:80},
  {name:"🪑 chair",addr:"Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6",score:80},
  {name:"😨 Stxtics",addr:"9FCWrtVCXHoyppdZMxBEGvLhdkugLrYTuecQnmd8WjHZ",score:80},
  {name:"🦹 kreo",addr:"GK8RNjG4wSD7nF7oyFMCLv9Kdbm76B5KT2AXQEqxffrZ",score:80},
  {name:"🦹 kreo",addr:"9RiJQAoWFQ4cgc8BRgR3DYNXVdKYjr2SWavi3nEWp1hs",score:80},
  {name:"🐸 Frog",addr:"4DdrfiDHpmx55i4SPssxVzS9ZaKLb8qr45NKY9Er9nNh",score:80},
  {name:"🦛 diego",addr:"AgaYcDQRmUJ6Z164qiNRK1PqkGMeGrF6eERHZkAkvkfa",score:80},
  {name:"🧊 Nyhrox",addr:"6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC",score:80},
  {name:"4️⃣ h14 dev",addr:"8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh",score:80},
  {name:"🌻 connor dev",addr:"HfuZ4EvaPvCGqTNxTZaS2bhSZbRF4gzKGH7PhDbDuaKw",score:80},
  {name:"👻 shah",addr:"HknfVes7oCMZ4ygZAovuu2ZjZ8cKZnNyNTsVcFdhfb3d",score:80},
  {name:"🧊 nyhrox",addr:"B439ckNd8tAHRzATQyv6h4zxctnWwaa8hUDThzAM5c99",score:80},
  {name:"🫧 Orynth",addr:"7c8XjugvjW5pMKkrV5myZfoWrQ1QHjwWC3RYZWUToJRk",score:80},
  {name:"🦹 kreo",addr:"2pPus3UwXrGrXe6NuUeTVwd6uGDaUGqj44mPPtQNrMJm",score:80},
  {name:"👋 cented brother",addr:"6nU2L7MQVUWjtdKHVpuZA9aind73nd3rXC4YFo8KQCy4",score:80},
  {name:"🦴 denza",addr:"GH9yk8vgFvHnAD8JZqXxr3hBN1Lr1mJ9NPzrP5mVqiJe",score:80},
  {name:"🐸 earl",addr:"7ZnaTAuAtXSAuAqcZkkAHJfomYgViUnFwbnnVn86chis",score:80},
  {name:"🐸 earl",addr:"5qmDCnAvQWVZoLwxoAMFfiohS9eU25WB51hiC95nmPrv",score:80},
  {name:"🐸 earl",addr:"6avQ6hGL39ipsWxmonFzrbE3Sf4iuwxkmGAPd1z71Rsg",score:80},
  {name:"👑 treydev",addr:"BM67m92U4H29Ej64v2UZEAABobYFzdQUCW9pHJ3229zf",score:80},
  {name:"🍙 Jerry",addr:"GmDXqHhXqfzEBErQqPft9xkznvgfkX6bcUT65MxQzNBj",score:80},
  {name:"🎥 psyopanime",addr:"A88uMtYGRx5CF4TT8L4L7KxjbPeW1o21mKMwfNcmH1db",score:80},
  {name:"💙 EIT8",addr:"EiT8EySXPcWnJEzk4GbzKCewwJPdi8mFQowjVQ973BMi",score:80},
  {name:"🪙 jhunno",addr:"Cyak1MKGCFVwjERbVXLn6bUXzBwp3H3WmhVdHE2aUQBU",score:80},
  {name:"♟️ asta",addr:"AstaWuJuQiAS3AfqmM3xZxrJhkkZNXtW4VyaGQfqV6JL",score:80},
  {name:"🏺 FnZ",addr:"FnZUzhGe4c1JGJFLrwfX3AdE2VTqbd6aEYyc1AbsMSiy",score:80},
  {name:"😀 aged bundle",addr:"7HAcpvFbErSwg4ozzN7Sf3aSJQ6ofZYwQBVsSNhqeh9a",score:80},
  {name:"🌇 frank fomo",addr:"498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ",score:80},
  {name:"🪴 frenzy1tx",addr:"YvEsBWpHK5PJ6Q8m4YrocwKeWys1NG67pbgi73UPnuX",score:80},
  {name:"🌩️ shocked",addr:"EcJWNtETrzdbj8s2dXpaE4Tu4r7fxALD6TNw9H8S6ksz",score:80},
  {name:"🦊 narc",addr:"CxgPWvH2GoEDENELne2XKAR2z2Fr4shG2uaeyqZceGve",score:80},
  {name:"🐻 +837k",addr:"GQhq5SXCotxcpzeRuaeXaNJS6LS45WSBVUJWGAqEVTix",score:80},
  {name:"🎹 qwerty",addr:"6W7kV1Ym3Uaw1vkA6Fu96GbEwypGeCVJS9Eb5oNbpCW8",score:80},
  {name:"🎹 qwerty",addr:"BLhQ4fWgkNAJ4MWXSdXaTnxwZxwHh7QTnMQb6i3Z2QYy",score:80},
  {name:"😀",addr:"J5HV8JixZcCXhHbiSGsax3KJA9L7PHCLzsDuUBCXtRmu",score:80},
  {name:"💰 reece bagstek",addr:"A8H8D8WegN7MgMdRAVYWU2uAcSTfZaC3c6pyLDF8CFXv",score:80},
  {name:"😀 dev",addr:"7VHbJ5Gje3jKrBfx91Q93AcSykwHtjVKLfDZqp6kK8um",score:80},
  {name:"👻 shah",addr:"7xwDKXNG9dxMsBSCmiAThp7PyDaUXbm23irLr7iPeh7w",score:80},
  {name:"🍃 leens",addr:"LeenseyyUU3ccdBPCFCrrZ8oKU2B3T2uToGGZ7eVABY",score:80},
  {name:"🧑‍💻 smart",addr:"9PLz3xVWBvr6frWQetsjtCftTgNpk1xwL6BAEf8endQm",score:80},
  {name:"🌷 leap",addr:"G3K9kWBDUmtnxypFZSzZDdMS9d8GWnZUrbsvobSJkwVG",score:80},
  {name:"💠 hexi",addr:"Fh3kfdQGDwzpiiME3X3h6dsbayd3ufrfP3GrdmJ7LKJT",score:80},
  {name:"💔 87",addr:"HpCcbBf6jpJBkBrMzUDzev6qnvQ73yd5LDMrts5a3Fzz",score:80},
  {name:"🌋 bronskee",addr:"CDKJ35ZD9jHivyEa3fMbxZSNrTERAS3CbrJbj4vP9f82",score:80},
  {name:"🎟️ aloh",addr:"jeWzw4Ys3cXpi5ScafwT6fgQ1jrrxb2iNoRSpjf45aw",score:80},
  {name:"👽 washy",addr:"GMwXfLtKhgtWdLqq29pF4JbUUQA6asUeEaXtjQSB7gpN",score:80},
  {name:"👽 washy",addr:"4zQG6oUwbjRrzVCG3wMAo6xuEBXe2doupdeeekKmPYUu",score:80},
  {name:"🎟️ aloh",addr:"6p7N4iZF9kuFvGk5nZdHDecNKW3Rct9zSDs2yhU1sdv",score:80},
  {name:"😀 21",addr:"999999rvdtNP6BXJt2U2d4bNtspZt3yzbbH5kPiJVTCi",score:80},
  {name:"🏦 BINANCEAPE",addr:"4wTHK33Vx8QZGhHkYFWnAFzWG2xwR1EpGTDdL7ze5LJo",score:80},
  {name:"🔺 suppress",addr:"D4ywmQk5ciaCssU4Kd2HcbFbU6iZcGVSwzUZcHGHYXhz",score:80},
  {name:"🕯️ wick",addr:"7SeUfPLcRxthg4EsPa31X56yugTfLSaYED6UZNJeKyqe",score:80},
  {name:"😅 loyal EL",addr:"DspCGdG7nHspS3u4RGR4wpgwT6pmh7SdKb6x7Bxb7iEn",score:80},
  {name:"🧧 Pain",addr:"5265FEFwZyH6V2U8wPy7xXRsyW4RivBFovkpDnSgs8St",score:80},
  {name:"🔱 kryptix",addr:"98H51VZLLvHmBXhyZFRB9Ho1ta5QWHLkGKbvZN8nJszF",score:80},
  {name:"😀 hunga",addr:"54MR2xmgjY3YQVsMHRaF9biJk1RTL1FeyUwjNrZ2uaiP",score:80},
  {name:"😀 hunga",addr:"E1qShZNBKNDcCo2fPaDVvR68vSLxhZazGX8jQVtVSF19",score:80},
  {name:"🦛 diego",addr:"Bmrcz8UjAHKGnreBAvpBdWjDR2KYZqQX2f5uC4FkkXTQ",score:80},
  {name:"🎟️ aloh",addr:"Cum5exPbTUGJgCUFYvQbBpJB1hibVWcdZrS7Sm9jRP2h",score:80},
  {name:"🔭 ozarke",addr:"2h6WT2yEMhpdLQRRX5tm58bEt174sbNZq7tMqzVtm3PW",score:80},
  {name:"🃏 waiterg",addr:"7Np5tf39tpvFSzWnGpwa54NeFkocGdr8DzWVHLktGZGp",score:80},
  {name:"🦋 mph",addr:"3vhoESzqFKZ7NAEM8cmjwqkxarn2RS12G2rNUmMnNkvn",score:80},
  {name:"🦋 mph",addr:"D9Eoby4puakYU3QX8aLGmQ3vqotWYk7V6YD7WtrKDfxw",score:80},
  {name:"🦋 mph",addr:"SF9TGdsfTPcA3ZVmPdPtYphgzRg6ZqUY4hnjPgjD1MW",score:80},
  {name:"🦋 mph",addr:"8isACVi8Bzknc9Ez6pvFft6e6aptjQTjxYU8LysvZTbn",score:80},
  {name:"🦋 mph",addr:"5UKK3PEL5aHLG8Z3c1CeWqK5BmzXqaw5p78h8zSzE28s",score:80},
  {name:"🗾 solana badge",addr:"GKXKJRKDrwqyttiF2M9a1LM6YKUSfFHeQ2RhY82Q71RU",score:80},
  {name:"😀 CHRIS",addr:"DunhuHYuuh7H231TrDMcUoKmNuMQRnxJ2DfV9nMaqege",score:80},
  {name:"🧨 saijax",addr:"4Y8Dbxk3vrDLdA7uPjXXLJN3qShAoLARdSusyvTkYSgQ",score:80},
  {name:"🌻 connorreo2",addr:"EwhEwoHVGne4PdjwVePfPEhzBKL1ZL7FTg7VNtscn2Ls",score:80},
  {name:"🦹 Kreoalt",addr:"mPEJqsRdVt1YXxuMNc5k9FvJdaS9ENSzAfHq1oPVzx5",score:80},
  {name:"🎂 eq",addr:"7w7f4P284zJhv3zotjCUmaNsZSsrHQKtpXGBJFq8gdzq",score:80},
  {name:"😀 sol clawdbot",addr:"8LJmEC1dRvXoyNPDeVmYsb6zrDyXrXecqZHFVFukRgCo",score:80},
  {name:"😀 flufy1",addr:"BpU41GDPBMHUwwYkrai6zEeyYLAMBggXUpS7z51muTif",score:80},
  {name:"😀 flufy",addr:"GPvG4Hkjh7WECEWsu2ev9usab11TSUwDMBgXH2DeGRBJ",score:80},
  {name:"😀 flufy",addr:"3xs5sV5t6uXDhtjuGKMnr5k6SaUnjxmyNY6wosfoCDpr",score:80},
  {name:"😀 flufy",addr:"6Uh3iHtfriPEDTezVce56Tgb7PS5o1mrRSzqANKt8Set",score:80},
  {name:"🍙 icemandot",addr:"5fLWPfB8qjZ8ARUgzL4f7chBuKKj4Fg4EbsA9vW5YKHG",score:80},
  {name:"🦹 Kreoalt",addr:"13aTrSA6SUEEAhKL3qc8Ns8tpQMEhffHUW3kecRzFC8X",score:80},
  {name:"😀 smart dev",addr:"37iEyj3wbuTqp92XywXcqmxjcUnA1rCir6odgpJFzEeQ",score:80},
  {name:"🫴 quant?",addr:"8d3Z7NjFwYxz2uo6c7rkpQZHnfcDCNDa7TVLDC1d1B4P",score:80},
  {name:"👜 scharo2",addr:"Fw57Uot5nGDg5jrUSFRXdCQDJ7xDBFwSCUrvMeADDLYk",score:80},
  {name:"👜 scharo3",addr:"874X2TgKNz2fUvZuu3rcbKMvzVPWTU2FNrMzjtwwsjKL",score:80},
  {name:"🧑‍🚒 Flames",addr:"6aXFYXbFob1ZKAEDCcqZnX2vooA3TgEqDoy5dAQbeWoV",score:80},
  {name:"🤠 Cowboy",addr:"6EDaVsS6enYgJ81tmhEkiKFcb4HuzPUVFZeom6PHUqN3",score:80},
  {name:"🐶 Tim",addr:"EdguS1Tx4ieBkyynZ3PUkdvYhb1vNjbDBNncb12NWVnE",score:80},
  {name:"🐶 sneaky",addr:"8rFMsTktKFM7HGeaz7fuhTFJqpbdUXBRHjyZZ5L5Sz6e",score:80},
  {name:"🦚 vev",addr:"vevK2LNSN4BSfQ4Aq28JtAG8hM2uVip4zwpRZdYL4PV",score:80},
  {name:"🦚 vev",addr:"Ctjk6aiH9rFpPejjfbUEVZi9FJZwg8ygT97QQoHGTYqo",score:80},
  {name:"🦚 vev",addr:"DU5uapuadiJKycAVgMf4ZKWWxhkhZ9RUuNH6Zk4oS4pz",score:80},
  {name:"🦓 aismart",addr:"6uw63EB8yWT99Naqh8L1Lmwi1TwFua8Sozk8dWDYU9rd",score:80},
  {name:"🦓 aismart2",addr:"Dwbn2Rkd86rdw2zADCeHmoaQ39jgru9cB47hEQhzaeJ8",score:80},
  {name:"🦓 aismart3",addr:"7b31vYgxhRWbT8raLNWcVqJj311bkM8boRqsZsFY9FS6",score:80},
  {name:"⚡ Stacker",addr:"HbCxe8yWQJWnK3f3FX4oohgm87FZuPYD4Ydszqxgkwft",score:80},
  {name:"✡️ Meggadev",addr:"8VUwMyYHkNn5qeC3Z2JY5k4BjkWXxNHoqvwSeWCSQKFu",score:80},
  {name:"💌 letteerbomb2",addr:"5GpPXNXFgVJ9vnhvccCJ2n1GtRQQrReF4agKSN5pZGCf",score:80},
  {name:"🌒 Userz",addr:"4ceopHPgw9wATNvAMnDdekQoLtRxs4ELvq4FAdMA8UQq",score:80},
  {name:"🦄 tekquant",addr:"FRa5xvWrvgYBHEukozdhJPCJRuJZcTn2WKj2u6L75Rmj",score:80},
  {name:"🐍 snaque",addr:"GkmyxRwPPwfRZK668SrjwAvv5hbVCkUgXFUu6eQ7Et3S",score:80},
  {name:"🐇 jade",addr:"9ZzjXiwkGRDBwVHJitfx8AmnN2YUbnqW6M1tH38juEeJ",score:80},
  {name:"⏰ China Wallet",addr:"2sREjHDebSmqK9XPVM5nHR91ssr82j3a6ZGbcfgr9J7R",score:80},
  {name:"🌒 Userz",addr:"5fwibAmiWd9zVv9bNfp3wNbtqTv5nd6FAe1yNJqzhzwB",score:80},
  {name:"🧀 Cotal",addr:"6XJb1yPuBuBbjh45xrMDS4GyqtztvBHBDodWVqyqizHh",score:80},
  {name:"🧀 Cotal",addr:"2AvmZrYjhBpYEnc21fXuw9tWutAHrwjAFsGXJLkVQoVX",score:80},
  {name:"⚡ chudsniper",addr:"chudvmyow2Vy5xp1ikPvbpEJv6fjMuPYVpW2kQJATaf",score:80},
  {name:"💤 zZZz",addr:"ZzZZzPoJxWKern9EMk88aik3P8KwKgptANPdrhERrwr",score:80},
  {name:"💙 Entropy",addr:"eAHPdAwmigwmMHXsLX4ibDh2ekQHCPdPxbffwdUUhj1",score:80},
  {name:"🫑 samsrep",addr:"CUHBzSPSaNS3tArEtM3maSV6pNdJhHJFYZpurPPK9P7H",score:80},
  {name:"🤣 wagmi",addr:"wgmioP6yGHB9WRtojJv2qpzj3v7zMUaYA9zWFGgrrbP",score:80},
  {name:"💤 zZZz",addr:"7DAWY3guSgAaa2d7y49JCGJxgTnGKBh7XaCmm1v2LkkC",score:80},
  {name:"💤 zZZz",addr:"Gvunzc6VsZXwmWD3QMR3zV1Lnd8ptobA3nMXjybTwX9q",score:80},
  {name:"💯 crypto villain",addr:"2XGR543rcHGqpxK6gtR5vxAyR7E8jAGiEbrtGyRa2NuC",score:80},
  {name:"☀️ lunar",addr:"BprdjjAzFLoS2gVJqUVR1pdJpwCacNK4kctLTiMmcdSh",score:80},
  {name:"☀️ lunar",addr:"2Xjizmu5FwVX36JyVGcWMDaNoQN1VWU25tz1TFk24nd7",score:80},
  {name:"🏳️‍🌈 theoalt",addr:"7Nt5HFpWzDfcvQLRmdRPkvDdq68n821wP1AGaWyqiAL6",score:80},
  {name:"🏳️‍🌈 theoalt",addr:"4Tf8hNjzyDQpbQ2CrJHqL9kC6HnDaN9pg4nEzdgHxVaG",score:80},
  {name:"🦓 aismart",addr:"9yYoY1t2752eh5T3W6Ckk6uFGp3e9R6J24NqqntTWDyU",score:80},
  {name:"⛑️ west",addr:"sYNUn7PJGiSVEXogedJuiXu2wzgsmvdRTesnr7MEezw",score:80},
  {name:"🧸 blaster",addr:"AVoW8jBv34tjAu5r8QcHXKzptMAFBmEEczEmMKZSNqq4",score:80},
  {name:"🪝 decu",addr:"4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9",score:80},
  {name:"🎭 criminal",addr:"HjNNPVtZUPqiRo2WWaJWHWncTpvdnnUqaWarYnrfDJgN",score:80},
  {name:"🦋 mph",addr:"5t1qjfihWT2JgWY2FiYikX1mdZaPcHYndv7qR6d12YEu",score:80},
  {name:"🫑 samsrep2",addr:"4xgnMkCPZN3AzZ3CnSVoQFiZmH31nseWiM4wvq8exERD",score:80},
  {name:"🙊 chair fake ansem",addr:"HXQxdXSQ812WPkkAAtqxb6pfXGMQE7Qi4SRpypB9LvK9",score:80},
  {name:"⚡ Infinite",addr:"DJEw8vxrVEtqXHkSiG3HARUEcx42v8aAUL8m4vWVhUL3",score:80},
  {name:"✡️ Megga",addr:"6QRdkwTSk9Kop6VdqSkSPah7a3HfqKHU5DD4BqMFCUQP",score:80},
  {name:"💖 ily",addr:"DXU65912VjiPUhKR37TLiHCrbp4uNHVNNZiBdLv1uAx1",score:80},
  {name:"🍈 marcell",addr:"FixmSpsBa7ew26gWdiqpoMAgKRFgbSXFbGAgfMZw67X",score:80},
  {name:"🦞 openai",addr:"83XBMJZEgQ13ZPFTaLr1ktNkUDHVmWpZRMN7AL7BXxnS",score:80},
  {name:"😀 lobstar",addr:"BFrLMv2vXEBSqLmTQabe2zEe9viU9uUPAoCHXFjXUogj",score:80},
  {name:"🐶 Tim",addr:"AfxdnsdzUGnXmFWaEXq6Hr9hninsWVpB5biJGN67PVpj",score:80},
  {name:"🔪 Euris",addr:"pEm51mXQqRTDYNnp9EfNPg5mL1rJaJfXKNXkbK56kYC",score:80},
  {name:"💨 dash",addr:"4ESzFZUWUdr2GsgHBVeQKuzAmBWS5sRSaXw6PZH2EAau",score:80},
  {name:"🐻 pullupso",addr:"65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE",score:80},
  {name:"🐴 quantwallet",addr:"12XmuPzMJjt1EzK39SYH8svHVDrMmoHZdP4ynKGH5QY4",score:80},
  {name:"🐴 quantwalletmulti",addr:"HjrHWsgwDQiceD3Rd24FhffKWvczEAHvLTYwbSm3xVNd",score:80},
  {name:"😀 tetsuoPID",addr:"5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7",score:80},
  {name:"⚠️ testuo?",addr:"GF6vq2zivjAqThz5ZFQ2DqdqgrNF5FRS3bDUCktcNyzk",score:80},
  {name:"😀 Tetsuo",addr:"FtVq2huUhU33TNmEbmEQb4kwDEfZeU9tFvBgk7mwWnBx",score:80},
  {name:"🌑 moonpay agent",addr:"DHPHERSkqfckRSEWCt1Kh6ajk2XypCwUC4rz3NtN3nHT",score:80},
  {name:"🪵 log",addr:"NiggaCd1i2bCVHQgPTjuPDazJVufuh19iRadTVthDye",score:80},
  {name:"⚙️ revrevrev",addr:"BoYDZhdrRmhWwqork2j7fx74CHSQJnFaNSXAXsDbVNSy",score:80},
  {name:"⛑️ west",addr:"28KxuZW9zo7j7c6oBHQkZsTY5vaNZExm9cCewogAaJou",score:80},
  {name:"🀄 Ethan FOMO",addr:"HiPHAy7TPgeRATovT6Ch4sayFBByuQ4Zp8Twe6i4qBNU",score:80},
  {name:"😻 ily",addr:"ACgGWUySLSudRFPdfVe1R5i4m1j6M3ovb42oF7hcL8Ud",score:80},
  {name:"🛬 vein",addr:"6to5wpbz4jLaRwVnDBQJgYoJWq2HsH3KHLwz3xYbQweF",score:80},
  {name:"🥶 gooseman",addr:"nizihwbZYSTVWQk88jUnwjCPGe5uXH8RCfZbSrC7GY9",score:80},
  {name:"🫡 Dgok",addr:"CtqqeD1TjCMCaYLg2GegfxcCgagJjf7qry2kXoAp5Sg3",score:80},
  {name:"😀 sillytuna",addr:"9SySPhJkumx6ZtMCwT8pMDkGBP2rkgcSAZC4oxKrDzGg",score:80},
  {name:"🌴 Zanjay",addr:"3MQhDy175W6TT4sXsDHLq8tc7EqpphjYrSXFQKdMKNr3",score:80},
  {name:"🔥 centeddev",addr:"8YcbyX92UHTU23HZv3ccP9o13qibErQkKaUjoxqxd7SJ",score:80},
  {name:"🍍 jerome",addr:"4bLUksHbExppTW6ChEZintHMmurt4JXRx7RZrEBXpQq3",score:80},
  {name:"🍍 jerome",addr:"CDg3bPoM21fSXEzrXWHWyJR33JHX6xaYboq5p7s4uo48",score:80},
  {name:"🕵️ jidn2",addr:"84m6fNN3DtGAR1b6BUrvXRA54jN55n8KxUGnMU5LALWR",score:80},
  {name:"🕵️ jidn2",addr:"8PgvaArcAVh16hQvcBt4iWFaHxEqhMR8zSoc3sbt1wwV",score:80},
  {name:"🦇 solcrow-fomo",addr:"Bf4zji6S979QySiGNjPJ2VMZ5i2SRVtAzfx8QUBScJm6",score:80},
  {name:"🐀 fizzwick",addr:"3pcmVZ1DwKbqnjbGbeg3FycThT1AkTpGQYB96jGU6oS1",score:80},
  {name:"💥 agent",addr:"GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG",score:80},
  {name:"🍍 jerome",addr:"GYaqGbgSd5iTiWUtfXMG57AfNdZwcd98y7eEfVhjQnVR",score:80},
  {name:"🥷 bandit",addr:"8GrjsuPip1xVDMjyVcVrG1wnH9Rutv7fdoxqtRBaymHc",score:80},
];

// Wallets to monitor for ANY buy — instant Telegram alert regardless of score
const WATCHED_WALLETS = [
  {name:'Mitch',emoji:'👽',addr:'4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t'},
  {name:'Hugo Martingale',emoji:'',addr:'Au1GUWfcadx7jMzhsg6gHGUgViYJrnPfL1vbdqnvLK4i'},
  {name:'Tim',emoji:'🍒',addr:'ARN1garjVGC4Ru2JnGsHdLaUQBbQhSXGAi5To3mdeJDz'},
  {name:'Cabal',emoji:'👻',addr:'HufqVoEtA6gJrkTnDi9ZwdYozX4V5fXurZbb3tt3jLz4'},
  {name:'itai',emoji:'💄',addr:'HdxkiXqeN6qpK2YbG51W23QSWj3Yygc1eEk2zwmKJExp'},
  {name:'Cupsey',emoji:'🍵',addr:'2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f'},
  {name:'CVNNOR',emoji:'⚓',addr:'9bAHNiCf3s4N7m2pJzdvWXRDsk9eRkSSbaYVSzAVb9Dv'},
  {name:'nyrhox',emoji:'🧊',addr:'87MZqjjJgpuFvaU8GyQJKbZGnCFFhX82qAjBGLRXPfcn'},
  {name:'connor REO',emoji:'🌼',addr:'9EyPAMyQvXaUWFxd2uQHvG8vpkKs33YdXvDvwmRXrUiH'},
  {name:'clukz',emoji:'🐔',addr:'G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC'},
  {name:'west',emoji:'⛑️',addr:'JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN'},
  {name:'cented',emoji:'🔥',addr:'CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o'},
  {name:'dv',emoji:'📲',addr:'BCagckXeMChUKrHEd6fKFA1uiWDtcmCXMsqaheLiUPJd'},
  {name:'+837K',emoji:'🐻',addr:'7R3KWHxzCf1eevnqHh4YymyTf4WsVJRwVHjrTGiV5zq1'},
  {name:'Keanu',emoji:'💣',addr:'Ez2jp3rwXUbaTx7XwiHGaWVgTPFdzJoSg8TopqbxfaJN'},
  {name:'Keanu',emoji:'💣',addr:'GMKNH8xEAfpMzk4oChsv3iLv6mAw8ksZQd6tbvLMuvLr'},
  {name:'Keanu',emoji:'💣',addr:'8i5U2uNBEuTc4zskYP14zbebDg2RSwrrG8REhEnJb97K'},
  {name:'dex',emoji:'📇',addr:'mW4PZB45isHmnjGkLpJvjKBzVS5NXzTJ8UDyug4gTsM'},
  {name:'kryptix',emoji:'🔱',addr:'AiLwAtCzPnQh6GnJ1UiMi9vqNniV3QyTM4rueKYNjPwN'},
  {name:'Nyhrox',emoji:'🧊',addr:'6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC'},
  {name:'nyhrox',emoji:'🧊',addr:'B439ckNd8tAHRzATQyv6h4zxctnWwaa8hUDThzAM5c99'},
  {name:'Orynth',emoji:'🫧',addr:'7c8XjugvjW5pMKkrV5myZfoWrQ1QHjwWC3RYZWUToJRk'},
  {name:'kreo',emoji:'🦹',addr:'2pPus3UwXrGrXe6NuUeTVwd6uGDaUGqj44mPPtQNrMJm'},
  {name:'Jerry',emoji:'🍙',addr:'GmDXqHhXqfzEBErQqPft9xkznvgfkX6bcUT65MxQzNBj'},
  {name:'psyopanime',emoji:'🎥',addr:'A88uMtYGRx5CF4TT8L4L7KxjbPeW1o21mKMwfNcmH1db'},
  {name:'jhunno',emoji:'🪙',addr:'Cyak1MKGCFVwjERbVXLn6bUXzBwp3H3WmhVdHE2aUQBU'},
  {name:'asta',emoji:'♟️',addr:'AstaWuJuQiAS3AfqmM3xZxrJhkkZNXtW4VyaGQfqV6JL'},
  {name:'frank fomo',emoji:'🌇',addr:'498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ'},
  {name:'narc',emoji:'🦊',addr:'CxgPWvH2GoEDENELne2XKAR2z2Fr4shG2uaeyqZceGve'},
  {name:'+837k',emoji:'🐻',addr:'GQhq5SXCotxcpzeRuaeXaNJS6LS45WSBVUJWGAqEVTix'},
  {name:'qwerty',emoji:'🎹',addr:'6W7kV1Ym3Uaw1vkA6Fu96GbEwypGeCVJS9Eb5oNbpCW8'},
  {name:'qwerty',emoji:'🎹',addr:'BLhQ4fWgkNAJ4MWXSdXaTnxwZxwHh7QTnMQb6i3Z2QYy'},
  {name:'',emoji:'😀',addr:'J5HV8JixZcCXhHbiSGsax3KJA9L7PHCLzsDuUBCXtRmu'},
  {name:'reece bagstek',emoji:'💰',addr:'A8H8D8WegN7MgMdRAVYWU2uAcSTfZaC3c6pyLDF8CFXv'},
  {name:'dev',emoji:'😀',addr:'7VHbJ5Gje3jKrBfx91Q93AcSykwHtjVKLfDZqp6kK8um'},
  {name:'87',emoji:'💔',addr:'HpCcbBf6jpJBkBrMzUDzev6qnvQ73yd5LDMrts5a3Fzz'},
  {name:'21',emoji:'😀',addr:'999999rvdtNP6BXJt2U2d4bNtspZt3yzbbH5kPiJVTCi'},
  {name:'wick',emoji:'🕯️',addr:'7SeUfPLcRxthg4EsPa31X56yugTfLSaYED6UZNJeKyqe'},
  {name:'hunga',emoji:'😀',addr:'54MR2xmgjY3YQVsMHRaF9biJk1RTL1FeyUwjNrZ2uaiP'},
  {name:'hunga',emoji:'😀',addr:'E1qShZNBKNDcCo2fPaDVvR68vSLxhZazGX8jQVtVSF19'},
  {name:'mph',emoji:'🦋',addr:'3vhoESzqFKZ7NAEM8cmjwqkxarn2RS12G2rNUmMnNkvn'},
  {name:'connorreo2',emoji:'🌻',addr:'EwhEwoHVGne4PdjwVePfPEhzBKL1ZL7FTg7VNtscn2Ls'},
  {name:'eq',emoji:'🎂',addr:'7w7f4P284zJhv3zotjCUmaNsZSsrHQKtpXGBJFq8gdzq'},
  {name:'sol clawdbot',emoji:'😀',addr:'8LJmEC1dRvXoyNPDeVmYsb6zrDyXrXecqZHFVFukRgCo'},
  {name:'flufy1',emoji:'😀',addr:'BpU41GDPBMHUwwYkrai6zEeyYLAMBggXUpS7z51muTif'},
  {name:'flufy',emoji:'😀',addr:'GPvG4Hkjh7WECEWsu2ev9usab11TSUwDMBgXH2DeGRBJ'},
  {name:'flufy',emoji:'😀',addr:'3xs5sV5t6uXDhtjuGKMnr5k6SaUnjxmyNY6wosfoCDpr'},
  {name:'smart dev',emoji:'😀',addr:'37iEyj3wbuTqp92XywXcqmxjcUnA1rCir6odgpJFzEeQ'},
  {name:'quant?',emoji:'🫴',addr:'8d3Z7NjFwYxz2uo6c7rkpQZHnfcDCNDa7TVLDC1d1B4P'},
  {name:'aismart',emoji:'🦓',addr:'6uw63EB8yWT99Naqh8L1Lmwi1TwFua8Sozk8dWDYU9rd'},
  {name:'aismart3',emoji:'🦓',addr:'7b31vYgxhRWbT8raLNWcVqJj311bkM8boRqsZsFY9FS6'},
  {name:'Userz',emoji:'🌒',addr:'4ceopHPgw9wATNvAMnDdekQoLtRxs4ELvq4FAdMA8UQq'},
  {name:'snaque',emoji:'🐍',addr:'GkmyxRwPPwfRZK668SrjwAvv5hbVCkUgXFUu6eQ7Et3S'},
  {name:'jade',emoji:'🐇',addr:'9ZzjXiwkGRDBwVHJitfx8AmnN2YUbnqW6M1tH38juEeJ'},
  {name:'Userz',emoji:'🌒',addr:'5fwibAmiWd9zVv9bNfp3wNbtqTv5nd6FAe1yNJqzhzwB'},
  {name:'Cotal',emoji:'🧀',addr:'2AvmZrYjhBpYEnc21fXuw9tWutAHrwjAFsGXJLkVQoVX'},
  {name:'chudsniper',emoji:'⚡',addr:'chudvmyow2Vy5xp1ikPvbpEJv6fjMuPYVpW2kQJATaf'},
  {name:'Entropy',emoji:'💙',addr:'eAHPdAwmigwmMHXsLX4ibDh2ekQHCPdPxbffwdUUhj1'},
  {name:'aismart',emoji:'🦓',addr:'9yYoY1t2752eh5T3W6Ckk6uFGp3e9R6J24NqqntTWDyU'},
  {name:'ily',emoji:'💖',addr:'DXU65912VjiPUhKR37TLiHCrbp4uNHVNNZiBdLv1uAx1'},
  {name:'openai',emoji:'🦞',addr:'83XBMJZEgQ13ZPFTaLr1ktNkUDHVmWpZRMN7AL7BXxnS'},
  {name:'lobstar',emoji:'😀',addr:'BFrLMv2vXEBSqLmTQabe2zEe9viU9uUPAoCHXFjXUogj'},
  {name:'tetsuoPID',emoji:'😀',addr:'5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7'},
  {name:'Tetsuo',emoji:'😀',addr:'FtVq2huUhU33TNmEbmEQb4kwDEfZeU9tFvBgk7mwWnBx'},
  {name:'moonpay agent',emoji:'🌑',addr:'DHPHERSkqfckRSEWCt1Kh6ajk2XypCwUC4rz3NtN3nHT'},
  {name:'revrevrev',emoji:'⚙️',addr:'BoYDZhdrRmhWwqork2j7fx74CHSQJnFaNSXAXsDbVNSy'},
  {name:'Ethan FOMO',emoji:'🀄',addr:'HiPHAy7TPgeRATovT6Ch4sayFBByuQ4Zp8Twe6i4qBNU'},
  {name:'ily',emoji:'😻',addr:'ACgGWUySLSudRFPdfVe1R5i4m1j6M3ovb42oF7hcL8Ud'},
  {name:'vein',emoji:'🛬',addr:'6to5wpbz4jLaRwVnDBQJgYoJWq2HsH3KHLwz3xYbQweF'},
  {name:'gooseman',emoji:'🥶',addr:'nizihwbZYSTVWQk88jUnwjCPGe5uXH8RCfZbSrC7GY9'},
  {name:'Dgok',emoji:'🫡',addr:'CtqqeD1TjCMCaYLg2GegfxcCgagJjf7qry2kXoAp5Sg3'},
  {name:'sillytuna',emoji:'😀',addr:'9SySPhJkumx6ZtMCwT8pMDkGBP2rkgcSAZC4oxKrDzGg'},
  {name:'solcrow-fomo',emoji:'🦇',addr:'Bf4zji6S979QySiGNjPJ2VMZ5i2SRVtAzfx8QUBScJm6'},
];

// ─── helpers ────────────────────────────────────────────────────────────────
function smHash(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h^s.charCodeAt(i))>>>0;return h;}
function fmtMC(n){if(!n||n<0)return'—';if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+n.toFixed(0);}
function httpGet(url){
  return new Promise((resolve,reject)=>{
    const mod=url.startsWith('https')?https:require('http');
    const req=mod.get(url,{headers:{'Accept':'application/json','User-Agent':'NEETScanner/1.2'}},res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(new Error('JSON parse: '+e.message));}});
    });
    req.on('error',reject);
    req.setTimeout(12000,()=>{req.destroy();reject(new Error('httpGet timeout: '+url));});
  });
}

function httpPost(url,body){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const u=new URL(url);
    const opts={hostname:u.hostname,port:443,path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};
    const req=https.request(opts,res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({ok:false,error_code:res.statusCode,description:'~on-JSON response: '+d.slice(0,200)});}});
    });
    req.on('error',reject);
    req.setTimeout(10000,()=>{req.destroy();reject(new Error('httpPost timeout: '+url));});
    req.write(data);req.end();
  });
}

// ─── Telegram send (loud, returns true/false, retries once) ────────────────
async function sendTG(msg){
  const url='https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage';
  const body={chat_id:TG_CHATID,text:msg,parse_mode:'Markdown',disable_web_page_preview:true};
  for(let attempt=1;attempt<=2;attempt++){
    try{
      const r=await httpPost(url,body);
      if(r && r.ok){
        console.log('[TG] sent ok (attempt '+attempt+')');
        return true;
      }
      console.error('[TG FAIL attempt '+attempt+']',
        'error_code=',r&&r.error_code,
        'description=',r&&r.description);
      if(r && r.error_code===429){
        const wait=(r.parameters&&r.parameters.retry_after?r.parameters.retry_after*1000:2000);
        console.error('[TG] rate-limited, waiting',wait,'ms');
        await new Promise(rs=>setTimeout(rs,wait));
        continue;
      }
      if(r && r.error_code===401){
        console.error('[TG FATAL] 401 Unauthorized — TG_TOKEN is invalid/revoked. Rotate it via @BotFather and update the repo secret.');
        return false;
      }
    }catch(e){
      console.error('[TG EXCEPTION attempt '+attempt+']',e.message);
    }
    await new Promise(rs=>setTimeout(rs,1500));
  }
  return false;
}

// ─── scoring ────────────────────────────────────────────────────────────────
function calcScore(t){let s=0;const mc=t.mc||0,vol=t.vol||0,liq=t.liq||0,p24=t.p24||0,p1=t.p1||0,sm=t.smCount||0;s+=Math.min(sm*15,45);if(mc>=15000&&mc<=100000)s+=15;else if(mc>100000&&mc<=500000)s+=10;else if(mc>500000&&mc<=2e6)s+=5;const vr=mc>0?vol/mc:0;if(vr>3)s+=12;else if(vr>1)s+=8;else if(vr>0.3)s+=4;if(liq>=8000&&liq<=80000)s+=8;else if(liq>=5000)s+=3;if(p24>100)s+=12;else if(p24>50)s+=9;else if(p24>20)s+=6;else if(p24>0)s+=2;if(p1>20)s+=8;else if(p1>5)s+=4;const lr=mc>0?liq/mc:0;if(liq<5000)s-=20;else if(liq<10000)s-=10;if(lr<0.03&&mc>20000)s-=35;else if(liq<15000&&p24<-30)s-=30;else if(liq<30000&&p24<-40)s-=20;if(p1<-50)s-=30;if(liq<15000&&(p24<-25||mc<25000))s-=40;else if(liq<30000&&p24<-35)s-=25;return Math.min(Math.max(Math.round(s),0),100);}
function classify(t){const sm=t.smCount||0,mc=t.mc||0,p24=t.p24||0,p1=t.p1||0;if(sm===0&&p24<-60)return'dead';if(mc<500000&&sm>=1&&p24>-20)return'early';if(sm>=2&&p1>=0)return'accumulating';if(p24>30||p1>8)return'hot';if(p24<-30&&sm<2)return'distributing';return'hot';}
function assignSM(score,addr){if(score<20)return[];addr=addr||'x';const h1=smHash(addr),h2=smHash(addr+'seed');if((h1%100)>=score)return[];const maxN=Math.min(4,Math.floor(score/20));const n=Math.max(1,(h2%maxN)+1);const ws=[...SM_WALLETS];for(let i=ws.length-1;i>0;i--){const j=smHash(addr+i)%(i+1);[ws[i],ws[j]]=[ws[j],ws[i]];}return ws.slice(0,n).map(w=>w.name);}

// ─── holder concentration check ─────────────────────────────────────────────
async function passesHolderFilter(mint){
  try{
    const [supplyResp,largestResp]=await Promise.all([
      httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getTokenSupply',params:[mint]}),
      httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:2,method:'getTokenLargestAccounts',params:[mint]})
    ]);
    const totalAmt=supplyResp.result&&supplyResp.result.value&&parseFloat(supplyResp.result.value.uiAmount||0);
    if(!totalAmt||totalAmt===0)return true; // can't verify, allow
    const accounts=(largestResp.result&&largestResp.result.value)||[];
    if(!accounts.length)return true;
    const topAmt=parseFloat(accounts[0].uiAmount||0);
    const pct=topAmt/totalAmt;
    console.log('[HOLDER]',mint.slice(0,8),'top holder:',+(pct*100).toFixed(1)+'%');
    return pct<=MAX_TOP_HOLDER;
  }catch(e){
    console.error('[HOLDER] check failed for',mint.slice(0,8),':',e.message);
    return true; // on RPC error, don't block the alert
  }
}

// ─── DexScreener fetch — 3 sources merged ──────────────────────────────────
async function fetchPairs(){
  const seen=new Set();
  let pairs=[];

  async function addTokenBatch(addrs){
    const chunks=[];
    for(let i=0;i<addrs.length;i+=30)chunks.push(addrs.slice(i,i+30));
    for(const c of chunks){
      try{
        const d=await httpGet('https://api.dexscreener.com/latest/dex/tokens/'+c.join(','));
        for(const p of (d.pairs||[])){
          if(p.chainId==='solana'&&!seen.has(p.pairAddress)){
            pairs.push(p);seen.add(p.pairAddress);
          }
        }
      }catch(e){console.error('[FETCH] batch error:',e.message);}
      await new Promise(r=>setTimeout(r,300));
    }
  }

  // Source 1: token-boosts/latest — updates whenever someone buys a boost (most real-time)
  try{
    const b=await httpGet('https://api.dexscreener.com/token-boosts/latest/v1');
    const arr=Array.isArray(b)?b:(b.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] boosts latest:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] token-boosts error:',e.message);}

  // Source 2: token-profiles/latest — updates when profiles are activated
  try{
    const p=await httpGet('https://api.dexscreener.com/token-profiles/latest/v1');
    const arr=Array.isArray(p)?p:(p.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] profiles latest:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] token-profiles error:',e.message);}

  // Source 3a: pump.fun grads file (updated every 15 min, used as a warm cache)
  try{
    const gradsFile=path.join(__dirname,'../pumpfun-grads.json');
    if(fs.existsSync(gradsFile)){
      const grads=JSON.parse(fs.readFileSync(gradsFile,'utf8'));
      const addrs=(grads.data||[]).map(g=>g.mint).filter(Boolean);
      console.log('[FETCH] pumpfun grads (file):',addrs.length,'tokens');
      if(addrs.length)await addTokenBatch(addrs);
    }
  }catch(e){console.error('[FETCH] pumpfun-grads file error:',e.message);}

  // Source 3b: pump.fun graduation API direct — fetches live graduates every scan
  // This catches coins that graduated AFTER the last pumpfun-grads.json file update
  try{
    const PF='https://frontend-api-v3.pump.fun';
    const PF_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const liveAddrs=[];
    for(const offset of [0,50]){
      try{
        const d=await httpGet(`${PF}/coins?offset=${offset}&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true`);
        const coins=Array.isArray(d)?d:(d.coins||d.data||[]);
        for(const c of coins){if(c.mint)liveAddrs.push(c.mint);}
      }catch(e){console.error('[FETCH] pumpfun live offset',offset,'error:',e.message);}
      await new Promise(r=>setTimeout(r,400));
    }
    const unique=[...new Set(liveAddrs)];
    console.log('[FETCH] pumpfun grads (live API):',unique.length,'tokens');
    if(unique.length)await addTokenBatch(unique);
  }catch(e){console.error('[FETCH] pumpfun-live error:',e.message);}

  // Source 4: DexScreener active boosts (different set from latest)
  try{
    const b=await httpGet('https://api.dexscreener.com/token-boosts/active/v1');
    const arr=Array.isArray(b)?b:(b.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] boosts active:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] boosts-active error:',e.message);}

  console.log('[FETCH] total unique pairs:',pairs.length);
  return pairs;
}

// ─── process pairs into scored candidates ───────────────────────────────────
function processPairs(pairs){
  const now=Date.now();
  return pairs.map(p=>{
    const mc=parseFloat(p.fdv||p.marketCap||0);
    const vol=parseFloat((p.volume||{}).h24||0);
    const liq=parseFloat((p.liquidity||{}).usd||0);
    const p24=parseFloat((p.priceChange||{}).h24||0);
    const p1 =parseFloat((p.priceChange||{}).h1 ||0);
    const bt=p.baseToken||{};
    const pairCreatedAt=p.pairCreatedAt?parseInt(p.pairCreatedAt):0;
    const t={name:bt.name||'Unknown',sym:bt.symbol||'?',pair:p.pairAddress||'',addr:bt.address||'',mc,vol,liq,p24,p1,pairCreatedAt};
    t.smNames=assignSM(calcScore({...t,smCount:0}),t.addr||t.pair||'');
    t.smCount=t.smNames.length;
    t.score=calcScore(t);
    t.cls=classify(t);
    return t;
  }).filter(t=>{
    if(t.mc<MC_MIN||t.mc>=MC_MAX)return false;         // $5K–$1M only
    if(t.vol<=VOL_MIN||t.liq<LIQ_MIN)return false;     // needs volume + liquidity
    if(t.pairCreatedAt&&(now-t.pairCreatedAt)>MAX_AGE_MS)return false; // skip old pairs
    return true;
  });
}

function buildMsg(t){
  const sym='$'+(t.sym||'???');
  const badge='🆕 NEW';
  const ci={early:'⚡',hot:'🔥',accumulating:'▲',distributing:'▼',dead:'☠'}[t.cls]||'';
  const rocket=t._rocket?' 🚀+'+Math.round((t._mcVel||0)*100)+'% MC/scan':'';
  const sm=(t.smNames||[]).slice(0,3).join(', ')||'—';
  const url=t.pair?'https://dexscreener.com/solana/'+t.pair:'#';
  return badge+' *'+sym+'*\nMC: '+fmtMC(t.mc)+' | Score: '+t.score+' '+ci+rocket+
         '\nLiq: '+fmtMC(t.liq)+' | Vol: '+fmtMC(t.vol)+'\nSM: '+sm+'\n'+url;
}

// ─── state ───────────────────────────────────────────────────────────────
function loadState(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    s.notifiedAt = s.notifiedAt || {};
    s.mcPrev    = s.mcPrev    || {};
    s.seenKeys  = s.seenKeys  || [];
    s.seenSigs  = s.seenSigs  || {};
    return s;
  }catch(e){
    return {notifiedAt:{},mcPrev:{},seenKeys:[],seenSigs:{}};
  }
}
function saveState(s){
  const mcKeys=Object.keys(s.mcPrev);
  if(mcKeys.length>3000){
    const keep=mcKeys.slice(-1500);
    const newMC={};for(const k of keep)newMC[k]=s.mcPrev[k];
    s.mcPrev=newMC;
  }
  if(s.seenKeys.length>20000)s.seenKeys=s.seenKeys.slice(-15000);
  fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));
}

// ─── watched-wallet buys (parallel, batches of 5) ──────────────────────────
async function checkOneWallet(wallet,state){
  try{
    const sigResp=await httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[wallet.addr,{limit:3,commitment:'confirmed'}]});
    if(!sigResp.result||!sigResp.result.length)return;
    if(!state.seenSigs[wallet.addr])state.seenSigs[wallet.addr]=[];
    for(const s of sigResp.result){
      if(s.err||state.seenSigs[wallet.addr].includes(s.signature))continue;
      const txResp=await httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getTransaction',params:[s.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]});
      if(!txResp.result||!txResp.result.meta){state.seenSigs[wallet.addr].push(s.signature);continue;}
      const pre=txResp.result.meta.preTokenBalances||[];
      const post=txResp.result.meta.postTokenBalances||[];
      let buyDetected=false;
      for(const pb of post){
        if(pb.owner!==wallet.addr||pb.mint===WSOL)continue;
        const preEntry=pre.find(p=>p.mint===pb.mint&&p.owner===wallet.addr);
        const preAmt=preEntry?parseFloat((preEntry.uiTokenAmount&&preEntry.uiTokenAmount.uiAmount)||0):0;
        const postAmt=parseFloat((pb.uiTokenAmount&&pb.uiTokenAmount.uiAmount)||0);
        if(postAmt>preAmt){
          const token=pb.mint;
          const label=(wallet.emoji?wallet.emoji+' ':'')+(wallet.name||wallet.addr.slice(0,8));
          const msg='🔔 *'+label+'* just bought!\n\nToken: `'+token+'`\nAmount: '+(postAmt-preAmt).toLocaleString(undefined,{maximumFractionDigits:2})+' tokens\n[DexScreener](https://dexscreener.com/solana/'+token+')';
          console.log('[WALLET BUY]',label,'->',token);
          const sent=await sendTG(msg);
          if(sent){state.seenSigs[wallet.addr].push(s.signature);}
          else{console.error('[WALLET BUY] TG send FAILED for',label,token,'— will retry next scan');}
          buyDetected=true;
          break;
        }
      }
      if(!buyDetected)state.seenSigs[wallet.addr].push(s.signature);
    }
    state.seenSigs[wallet.addr]=state.seenSigs[wallet.addr].slice(-200);
  }catch(e){console.error('[WALLET_BUY]',wallet.name,'error:',e.message);}
}

async function checkWalletBuys(state){
  const BATCH=5;
  for(let i=0;i<WATCHED_WALLETS.length;i+=BATCH){
    await Promise.all(WATCHED_WALLETS.slice(i,i+BATCH).map(w=>checkOneWallet(w,state)));
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main(){
  console.log('=== NEET Scanner',new Date().toISOString(),'===');
  const state=loadState();
  console.log('[STATE] seenKeys size:',state.seenKeys.length);

  await checkWalletBuys(state);

  const pairs=await fetchPairs();
  if(!pairs.length){
    console.warn('[MAIN] 0 pairs returned — upstream outage?');
    saveState(state);
    return;
  }
  const tokens=processPairs(pairs);
  console.log('[MAIN] candidate tokens after filter:',tokens.length);

  const seenSet=new Set(state.seenKeys);
  let sent=0, alreadySeen=0, belowThr=0, crashFilter=0, holderFiltered=0, ageFiltered=0;

  for(const t of tokens){
    const k=t.addr||t.pair||t.sym;
    if(!k)continue;

    // crash filter
    if(t.p1<-50||t.p24<-70){crashFilter++;continue;}

    // rocket detection via MC velocity
    if(state.mcPrev[k]&&state.mcPrev[k]>0&&t.mc>0){
      t._mcVel=(t.mc-state.mcPrev[k])/state.mcPrev[k];
      if(t._mcVel>=0.4){t._rocket=true;t.score=Math.min(100,t.score+15);}
    }
    state.mcPrev[k]=t.mc;

    const thr=t._rocket?ROCKET_THRESHOLD:SCORE_THRESHOLD;
    if(t.score<thr){belowThr++;continue;}

    // ══ STRICT DEDUP: one alert per coin, ever ══
    if(seenSet.has(k)){alreadySeen++;continue;}

    // holder concentration check (only runs for coins that passed score filter)
    const holderOk=await passesHolderFilter(t.addr||'');
    if(!holderOk){
      console.log('[HOLDER] skip',t.sym,'— top holder >8%');
      holderFiltered++;
      // mark seen so we don't re-check every scan
      seenSet.add(k);
      state.seenKeys.push(k);
      continue;
    }

    // attempt send — only mark seen on success
    const ok=await sendTG(buildMsg(t));
    if(ok){
      seenSet.add(k);
      state.seenKeys.push(k);
      state.notifiedAt[k]=Date.now();
      sent++;
      await new Promise(r=>setTimeout(r,500));
    }else{
      console.error('[MAIN] send failed for',t.sym,'('+k+') — will retry next scan');
    }
  }

  saveState(state);
  console.log('[MAIN] done. sent:',sent,'| seen:',alreadySeen,'| below-thr:',belowThr,'| crash:',crashFilter,'| holder-filtered:',holderFiltered);
}

main().catch(e=>{console.error('[FATAL]',e);process.exit(1);});
