const express = require("express");

// Fix for node-fetch v3 in CommonJS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
// Use Render's PORT in production, fall back to 3000 locally
const PORT = process.env.PORT || 3000;

// 🔑 Your API key
const API_KEY = "e8967ea5-9b93-4ba1-9657-0fd8b1b84497";

// Helper: get YYYY-MM-DD in LOCAL time (PST for you)
function formatDateLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Helper: format start time in PST like "4:00 PM"
function formatStartTimePST(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Helper: break an array into chunks of size n
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Convert American odds to implied probability (0–1)
function americanToProb(price) {
  const n = Number(price);
  if (isNaN(n) || n === 0) return NaN;
  if (n > 0) {
    return 100 / (n + 100);
  } else {
    return -n / (-n + 100);
  }
}

// Format American odds with + for positive numbers
function formatAmerican(price) {
  const n = Number(price);
  if (isNaN(n)) return price;
  return n > 0 ? `+${n}` : `${n}`;
}

// Fetch odds for a list of fixture IDs (FanDuel: ML + Spread + Total)
async function fetchOddsForFixtures(fixtureIds) {
  const oddsByFixtureId = {};

  if (!fixtureIds || fixtureIds.length === 0) {
    return oddsByFixtureId;
  }

  const batches = chunkArray(fixtureIds, 5);

  for (const batch of batches) {
    const params = new URLSearchParams();
    batch.forEach((id) => params.append("fixture_id", id));
    params.append("sportsbook", "FanDuel");
    params.append("odds_format", "AMERICAN");
    params.append("is_main", "true");

    const url = `https://api.opticodds.com/api/v3/fixtures/odds?${params.toString()}`;

    const resp = await fetch(url, {
      headers: { "X-Api-Key": API_KEY },
    });

    const json = await resp.json();

    if (json.data && Array.isArray(json.data)) {
      json.data.forEach((fixture) => {
        oddsByFixtureId[fixture.id] = fixture.odds || [];
      });
    }
  }

  return oddsByFixtureId;
}

// Fetch results (scores) for a list of fixture IDs
async function fetchResultsForFixtures(fixtureIds) {
  const resultsById = {};
  if (!fixtureIds || fixtureIds.length === 0) return resultsById;

  const batches = chunkArray(fixtureIds, 5);

  for (const batch of batches) {
    const params = new URLSearchParams();
    batch.forEach((id) => params.append("fixture_id", id));
    params.append("sport", "basketball");
    params.append("league", "nba");

    const url = `https://api.opticodds.com/api/v3/fixtures/results?${params.toString()}`;

    const resp = await fetch(url, {
      headers: { "X-Api-Key": API_KEY },
    });

    const json = await resp.json();

    if (json.data && Array.isArray(json.data)) {
      json.data.forEach((fixtureResult) => {
        const fxId = fixtureResult.fixture?.id || fixtureResult.id;
        if (fxId) {
          resultsById[fxId] = fixtureResult;
        }
      });
    }
  }

  return resultsById;
}

// 🔍 Safely pull scores from any of the shapes OpticOdds might use
function extractScores(game, resultFixture) {
  const candidates = [];

  if (resultFixture) {
    candidates.push(resultFixture);
    if (resultFixture.fixture) candidates.push(resultFixture.fixture);
    if (resultFixture.result) candidates.push(resultFixture.result);
    if (resultFixture.fixture && resultFixture.fixture.result) {
      candidates.push(resultFixture.fixture.result);
    }
  }

  if (game) {
    candidates.push(game);
    if (game.result) candidates.push(game.result);
  }

  for (const c of candidates) {
    const home = c?.scores?.home?.total;
    const away = c?.scores?.away?.total;
    if (typeof home === "number" && typeof away === "number") {
      return { homeScore: home, awayScore: away };
    }
  }

  return { homeScore: null, awayScore: null };
}

app.get("/", async (req, res) => {
  try {
    const now = new Date();
    const today = formatDateLocal(now);

    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(now.getDate() + 1);
    const tomorrow = formatDateLocal(tomorrowDate);

    // Fixtures for today & tomorrow (for schedule)
    const urls = [
      `https://api.opticodds.com/api/v3/fixtures?sport=basketball&league=nba&start_date=${today}`,
      `https://api.opticodds.com/api/v3/fixtures?sport=basketball&league=nba&start_date=${tomorrow}`,
    ];

    const responses = await Promise.all(
      urls.map((url) =>
        fetch(url, {
          headers: { "X-Api-Key": API_KEY },
        })
      )
    );

    const jsons = await Promise.all(responses.map((r) => r.json()));

    let allGames = [];
    jsons.forEach((j) => {
      if (j.data && Array.isArray(j.data)) {
        allGames = allGames.concat(j.data);
      }
    });

    if (allGames.length === 0) {
      return res.send("<h1>No NBA games found for today or tomorrow.</h1>");
    }

    // Get odds for these fixtures (FanDuel ML + Spread + Total)
    const fixtureIds = allGames.map((g) => g.id);
    const oddsByFixtureId = await fetchOddsForFixtures(fixtureIds);

    // Get results (scores) for these fixtures by id
    const resultsById = await fetchResultsForFixtures(fixtureIds);

    // Group games by date
    const gamesByDate = {};
    allGames.forEach((game) => {
      const dateKey = game.start_date.split("T")[0];
      if (!gamesByDate[dateKey]) {
        gamesByDate[dateKey] = [];
      }
      gamesByDate[dateKey].push(game);
    });

    const sortedDates = Object.keys(gamesByDate).sort();

    const lastUpdated = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
    });

    // Build HTML with styling + auto-refresh
    let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>NBA Schedule (Today & Tomorrow)</title>
  <meta http-equiv="refresh" content="30" />
  <style>
    body {
      margin: 0;
      padding: 24px 20px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #050816;
      color: #e5e7eb;
      font-size: 16px;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
    }
    h1 {
      text-align: center;
      margin-bottom: 4px;
      font-size: 1.9rem;
    }
    .subtitle-main {
      text-align: center;
      font-size: 1rem;
      font-weight: 500;
      opacity: 0.9;
      margin-bottom: 4px;
    }
    .subtitle-meta {
      text-align: center;
      font-size: 0.8rem;
      opacity: 0.6;
      margin-bottom: 22px;
    }
    .date-section {
      margin-bottom: 26px;
    }
    .date-header {
      font-size: 1.2rem;
      font-weight: 600;
      margin-bottom: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.15);
      padding-bottom: 4px;
    }
    .date-tag {
      font-size: 0.8rem;
      opacity: 0.8;
      margin-left: 6px;
    }
    .games-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .game-card {
      background: radial-gradient(circle at top left, #111827, #020617);
      border-radius: 14px;
      padding: 14px 16px;
      border: 1px solid rgba(15,23,42,0.9);
      box-shadow: 0 10px 24px rgba(0,0,0,0.5);
      font-size: 0.9rem;
      line-height: 1.45;
    }
    .game-card-inner {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .game-card-main {
      min-width: 0;
    }
    .game-card-odds {
      min-width: 0;
    }
    @media (min-width: 900px) {
      .game-card-inner {
        flex-direction: row;
        justify-content: space-between;
        gap: 18px;
        align-items: flex-start;
      }
      .game-card-main {
        flex: 0 0 40%;
      }
      .game-card-odds {
        flex: 1;
      }
    }
    .teams-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-weight: 600;
      margin-bottom: 6px;
      font-size: 1.05rem;
    }
    .teams-names {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .teams-names span {
      white-space: nowrap;
    }
    .vs {
      font-weight: 400;
      opacity: 0.7;
      margin: 0 4px;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 0.8rem;
      opacity: 0.9;
      margin-bottom: 4px;
      align-items: center;
    }
    .status-tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-right: 4px;
    }
    .status-live {
      background: #dc2626;
      color: #fee2e2;
    }
    .status-unplayed {
      background: #22c55e;
      color: #022c22;
    }
    .status-completed {
      background: #4b5563;
      color: #e5e7eb;
    }

    .final-box {
      background: #020617;
      border-radius: 12px;
      padding: 8px 10px;
      border: 1px solid rgba(148,163,184,0.6);
      margin-bottom: 8px;
    }
    .final-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.7;
      margin-bottom: 3px;
    }
    .final-score {
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 2px;
      white-space: nowrap;
    }
    .final-winner {
      font-size: 0.84rem;
      opacity: 0.85;
    }

    .odds-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
      font-size: 0.88rem;
    }
    .odds-label {
      font-weight: 600;
      font-size: 0.82rem;
      opacity: 0.9;
      margin-right: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .odds-chip {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.85rem;
      font-weight: 500;
      white-space: nowrap;
      background: #020617;
      border: 1px solid #4b5563;
      color: #f9fafb;
    }
    .odds-chip-fav {
      border-color: #22c55e;
      box-shadow: 0 0 0 1px rgba(34,197,94,0.25);
    }
    .odds-chip-dog {
      border-color: #ef4444;
      box-shadow: 0 0 0 1px rgba(239,68,68,0.25);
    }

    .no-odds {
      font-size: 0.75rem;
      opacity: 0.6;
      margin-top: 2px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>NBA Schedule (Today & Tomorrow)</h1>
    <div class="subtitle-main">
      Powered by OpticOdds
    </div>
    <div class="subtitle-meta">
      Auto-refreshes every 30 seconds · Last updated (PST): ${lastUpdated}
    </div>
`;

    sortedDates.forEach((date) => {
      let tag = "";
      if (date === today) tag = "Today";
      else if (date === tomorrow) tag = "Tomorrow";

      html += `<div class="date-section">`;
      html += `<div class="date-header">${date}${
        tag ? `<span class="date-tag">(${tag})</span>` : ""
      }</div>`;
      html += `<div class="games-list">`;

      gamesByDate[date].forEach((game) => {
        const status = (game.status || "").toLowerCase();
        let statusClass = "status-unplayed";
        if (status === "live") statusClass = "status-live";
        else if (status === "completed") statusClass = "status-completed";

        const oddsArray = oddsByFixtureId[game.id] || [];

        const moneyline = oddsArray.filter(
          (o) => o.market === "Moneyline" && o.is_main
        );
        const spreads = oddsArray.filter(
          (o) => o.market === "Point Spread" && o.is_main
        );
        const totals = oddsArray.filter(
          (o) => o.market === "Total Points" && o.is_main
        );

        const startTimePST = formatStartTimePST(game.start_date);

        // Scores & winner
        const resultFixture = resultsById[game.id];
        const { homeScore, awayScore } = extractScores(game, resultFixture);

        let finalScoreText = "";
        let finalWinnerText = "";
        let finalFallbackText = "";

        if (status === "completed") {
          const homeName = game.home_team_display;
          const awayName = game.away_team_display;

          if (
            typeof homeScore === "number" &&
            typeof awayScore === "number"
          ) {
            finalScoreText = `${awayName} ${awayScore} \u2013 ${homeScore} ${homeName}`;
            let winner = "";
            if (homeScore > awayScore) winner = homeName;
            else if (awayScore > homeScore) winner = awayName;
            else winner = "Tie";

            finalWinnerText =
              winner === "Tie" ? "Tie" : `Winner: ${winner}`;
          } else {
            finalFallbackText = "Final score not available yet.";
          }
        }

        html += `<div class="game-card"><div class="game-card-inner">`;

        // LEFT: Teams + meta
        html += `
          <div class="game-card-main">
            <div class="teams-row">
              <div class="teams-names">
                <span>${game.away_team_display}</span>
                <span class="vs">@</span>
                <span>${game.home_team_display}</span>
              </div>
            </div>
            <div class="meta">
              <span class="status-tag ${statusClass}">${game.status}</span>
              <span>Start: ${startTimePST} PST</span>
            </div>
          </div>
        `;

        // RIGHT: Final box (if completed) + odds
        html += `<div class="game-card-odds">`;

        if (status === "completed") {
          if (finalScoreText || finalWinnerText) {
            html += `<div class="final-box">
              <div class="final-label">Final</div>
              <div class="final-score">${finalScoreText}</div>
              ${
                finalWinnerText
                  ? `<div class="final-winner">${finalWinnerText}</div>`
                  : ""
              }
            </div>`;
          } else {
            html += `<div class="final-box">
              <div class="final-label">Final</div>
              <div class="final-score">${finalFallbackText}</div>
            </div>`;
          }
        }

        const getFavoriteIndex = (oddsList) => {
          if (!oddsList || oddsList.length === 0) return -1;
          let bestIdx = 0;
          let bestProb = americanToProb(oddsList[0].price);
          for (let i = 1; i < oddsList.length; i++) {
            const p = americanToProb(oddsList[i].price);
            if (!isNaN(p) && (isNaN(bestProb) || p > bestProb)) {
              bestProb = p;
              bestIdx = i;
            }
          }
          return bestIdx;
        };

        const mlFavIndex = getFavoriteIndex(moneyline);
        const spreadFavIndex = getFavoriteIndex(spreads);

        // ML
        if (moneyline.length > 0) {
          html += `<div class="odds-row"><span class="odds-label">ML</span>`;
          moneyline.forEach((o, idx) => {
            const formatted = formatAmerican(o.price);
            const chipClass =
              idx === mlFavIndex ? "odds-chip-fav" : "odds-chip-dog";
            html += `<span class="odds-chip ${chipClass}">${o.selection || o.name}: ${formatted}</span>`;
          });
          html += `</div>`;
        }

        // Spread
        if (spreads.length > 0) {
          html += `<div class="odds-row"><span class="odds-label">SPREAD</span>`;
          spreads.forEach((o, idx) => {
            const formatted = formatAmerican(o.price);
            const chipClass =
              idx === spreadFavIndex ? "odds-chip-fav" : "odds-chip-dog";
            html += `<span class="odds-chip ${chipClass}">${o.name}: ${formatted}</span>`;
          });
          html += `</div>`;
        }

        // Total (Over/Under) – Over = green, Under = red
        if (totals.length > 0) {
          html += `<div class="odds-row"><span class="odds-label">TOTAL</span>`;
          totals.forEach((o) => {
            const formatted = formatAmerican(o.price);
            const nameLower = (o.name || "").toLowerCase();
            let chipClass = "";
            if (nameLower.startsWith("over")) {
              chipClass = "odds-chip-fav";
            } else if (nameLower.startsWith("under")) {
              chipClass = "odds-chip-dog";
            }
            html += `<span class="odds-chip ${chipClass}">${o.name}: ${formatted}</span>`;
          });
          html += `</div>`;
        }

        if (
          status !== "completed" &&
          moneyline.length === 0 &&
          spreads.length === 0 &&
          totals.length === 0
        ) {
          html += `<div class="no-odds">No FanDuel odds available yet.</div>`;
        }

        html += `</div></div></div>`;
      });

      html += `</div></div>`;
    });

    html += `
  </div>
</body>
</html>
`;

    res.send(html);
  } catch (err) {
    console.error("Error fetching NBA data:", err);
    res.status(500).send("Error fetching NBA data.");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

