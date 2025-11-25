const express = require("express");
const fetch = require("node-fetch");

const API_KEY = "e8967ea5-9b93-4ba1-9657-0fd8b1b84497";
const app = express();
const PORT = 3000;

app.get("/", (req, res) => {
    res.send("<h1>NBA Scoreboard API is running</h1><p>Go to /nba to see today's games.</p>");
});

app.get("/nba", async (req, res) => {
    try {
        const url = "https://api.opticodds.com/api/v3/fixtures?sport=Basketball&league=nba";

        const response = await fetch(url, {
            headers: { "X-Api-Key": API_KEY }
        });

        const json = await response.json();

        if (!json.data) return res.send("No data returned.");

        let html = `
            <h2>NBA Games</h2>
            <table border="1" cellpadding="6">
                <tr>
                    <th>Home</th>
                    <th>Away</th>
                    <th>Status</th>
                    <th>Start Time</th>
                </tr>
        `;

        json.data.forEach(game => {
            html += `
                <tr>
                    <td>${game.home_team_display}</td>
                    <td>${game.away_team_display}</td>
                    <td>${game.status}</td>
                    <td>${game.start_date}</td>
                </tr>
            `;
        });

        html += "</table>";
        res.send(html);

    } catch (e) {
        res.send("Error fetching NBA data: " + e);
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
