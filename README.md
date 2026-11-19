# BiteWise

**Eat Smart. Spend Less.**

BiteWise finds the same dish at the same restaurant on **Swiggy** and **Zomato**
and shows the two menu prices side by side, so you can see where it's cheaper
before you order.

It talks only to the platforms' official MCP servers, logs in as you through
their own sign-in pages, and is strictly read-only: it can search menus, but it
can never add to a cart, place an order or pay.

Data **Powered by Swiggy** · **Powered by Zomato**

## Features

- **Head-to-head comparison:** the same restaurant and dish on both apps, with
  each app's price, rating, delivery time and offer, and which one is cheaper.
- **Careful matching:** different portions (half/full, 500 ml, 2 pcs),
  combos and thalis, veg vs non-veg, and different outlets of the same chain are
  never merged. Uncertain pairs are listed separately as "possible matches".
- **Same-location check:** confirms your Swiggy and Zomato saved addresses
  are the same place before comparing prices.
- **Sort and filter:** biggest saving, lowest price, top rated or fastest
  delivery, plus a veg-only filter.
- **Works on phones:** results turn into cards on small screens.
- **Command line too:** the same comparison as a terminal table, with full
  JSON output.

## Requirements

- Node.js 20.12 or newer
- A Swiggy account and a Zomato account, each with at least one saved delivery
  address

## Getting started

```bash
npm install
cp .env.example .env    # optional: the defaults work

npm run login           # Swiggy: opens your browser, sign in with phone + OTP
npm run login:zomato    # Zomato: same

npm run web             # then open http://localhost:3000
```

You enter your phone number and OTP on Swiggy's and Zomato's own pages;
BiteWise never sees them. Logins last about 30 days and refresh automatically.

## Command line

| Command | What it does |
|---|---|
| `npm run compare -- "masala dosa"` | Swiggy vs Zomato comparison in the terminal; full results in `out/compare-<dish>.json` |
| `npm run search -- "masala dosa"` | Swiggy only: every result, cheapest first |
| `npm run tools` | Lists the Swiggy MCP tools (schemas in `out/tools.json`) |
| `npm test` | Runs the matching unit tests |

If you have several saved Swiggy addresses, the first `search` asks which one
to use. If BiteWise can't confidently match it to one of your Zomato addresses,
`compare` asks you to pick that too. Both choices are remembered in
`.prefs.json`; delete it to choose again.

Searches can be linked directly: `http://localhost:3000/?q=masala%20dosa`.

## Configuration

All settings are optional and go in `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Web UI port |
| `HOST` | `127.0.0.1` | Address the web server listens on. Loopback only by default, because the API acts with your logins |
| `CACHE_TTL_SECONDS` | `300` | How long search results are cached locally |
| `OAUTH_CALLBACK_PORT` | `8976` | Port for the login redirect (`http://localhost:<port>/callback`) |
| `PLATFORM_ZOMATO` | `live` | `mock` uses the bundled sample data in `fixtures/zomato/` for Zomato, clearly labelled as sample data |

## How it works

1. **Swiggy:** a single `search_menu` call returns matching dishes from nearby
   restaurants, with price, rating and delivery time.
2. **Address check:** neither platform exposes coordinates for saved
   addresses, so BiteWise compares the address text (sector numbers and
   pincodes are decisive). If it can't confirm both apps point at the same
   place, the web UI refuses to compare rather than guess.
3. **Zomato:** there is no cross-restaurant dish search, so BiteWise finds
   restaurants by keyword, reads each menu's item list, then fetches prices for
   the matching categories. It also looks up a few of the Swiggy restaurants by
   name, because the two apps' keyword searches often surface different places.
4. **Matching:** restaurants, then dishes, are paired by name similarity, with
   hard guards for portion, combo, veg/non-veg and outlet. Pairs scoring at
   least 0.75 (restaurant) and 0.8 (dish) are matched; pairs from 0.55 are shown
   as possible matches; everything else is listed under "Only on Swiggy" or
   "Only on Zomato".

Calls are made one at a time, 600 ms apart, and results are cached for five
minutes.

## Project structure

```
src/
  server.ts          web server: /api/compare and /api/search
  compare.ts         runs a comparison and groups the results
  matching.ts        restaurant, dish and address matching (unit-tested)
  platform.ts        shared types for the platform clients
  swiggy/client.ts   Swiggy MCP client with a read-only tool allowlist
  zomato/client.ts   Zomato MCP client with a read-only tool allowlist, plus sample-data mode
  mcp/               OAuth sign-in and token storage
  cli/               command-line entry points
public/index.html    the web UI
fixtures/zomato/     sample Zomato data for PLATFORM_ZOMATO=mock
```

## Privacy and safety

- **Read-only by design:** each platform client only allows its search and
  menu tools. Cart, checkout, order, payment and phone-binding tools are
  refused in code.
- **Stays on your machine:** login tokens (`.tokens*.json`), your address
  choice (`.prefs.json`), the cache and command output are stored locally and
  excluded from Git. The web server listens on `127.0.0.1` unless you change
  `HOST`.
- **Shown as returned:** prices, ratings and offers are displayed exactly as
  each platform returns them.

## Limitations

- **Menu prices only.** Delivery and platform fees, taxes and discounts are
  not included, so this is never the final amount you pay. Offers are shown as
  text next to the price.
- **Partial coverage.** Each search reads one page of Swiggy results (about 10
  dishes) and up to 5 Zomato restaurants, plus 3 name lookups.
- **Zomato rate limit.** A fresh search makes up to about 17 Zomato calls, so
  many searches within an hour can hit Zomato's hourly limit. Repeat searches
  within five minutes come from the cache.
- **Unlabelled portions.** If neither app states the size, identical dish
  names can still hide different portions.

## Platform terms

BiteWise is a personal, non-commercial project and is not affiliated with or
endorsed by Swiggy or Zomato.

- **Swiggy:** results must carry "Powered by Swiggy" attribution next to them.
  Swiggy's builder guidelines restrict using its APIs for "competitive
  intelligence or benchmarking", so check with Swiggy (builders@swiggy.in)
  before sharing or deploying a cross-platform comparison. Production access
  requires approval via https://mcp.swiggy.com/builders/access/.
- **Zomato:** the Zomato MCP server is offered for personal use and testing
  only, and Zomato does not currently allow third-party apps to be built on it
  (see https://github.com/Zomato/mcp-server-manifest).
