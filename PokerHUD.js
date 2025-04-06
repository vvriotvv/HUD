// ==UserScript==
// @name         RiotPokerHUD
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Poker HUD for Torn designed by Riot
// @match        https://www.torn.com/page.php?sid=holdem
// @grant        none
// @require https://cdn.jsdelivr.net/npm/dexie@3.2.5/dist/dexie.min.js
// ==/UserScript==

const pokerData = {
    hands: [],
    players: {},
    round: null,
    lastRaisePlayerID: null,
    handInProgress: false,
    seatedPlayerIDs: [],
    lastPlayerStates: {},
    activePlayerIDs: [],
    communityCards: [],
    myCards: [],
    allowTracking: false,
    revealedPlayers: new Set(),
    wtsdCountedThisHand: new Set(),
    GameID: null,
};

const db = new Dexie("PokerHUD");
db.version(1).stores({
    players: "&id, name, handsPlayed",
});


(function () {
    'use strict';

    const OriginalWebSocket = window.WebSocket;
    function isJsonString(str) {
        try {
            const obj = JSON.parse(str);
            return typeof obj === 'object' && obj !== null;
        } catch (e) {
            return false;
        }
    }

    window.WebSocket = function (url, protocols) {
        const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);

        ws.addEventListener('message', function (event) {
            try {
                const msg = event.data;
                if (!isJsonString(msg)) return; // First, skip if it's not JSON
                const data = JSON.parse(msg);
                const channel = data?.result?.channel;
                if (!channel || !channel.startsWith('holdem')) // Ensure channel exists and starts with 'holdem'
                {
                    return;
                }

                const message = data?.result?.data?.data?.message;
                //console.log("WebSocket parsed:", data);
                if (!message) return;

                // Route based on event type
                switch (message.eventType) {
                    case "playerMakeMove":
                        break;
                    case "chat": {
                        const chat = message.data;
                        if (chat.meta === "action") {
                        } else if (chat.meta === "state") {
                            handleGameState(message);
                        } else if (chat.meta === "won") {
                        }
                    }
                        break;
                    default:
                        break;
                }

            } catch (e) {
                console.error("WebSocket message parse error:", e);
            }
        });

        ws.addEventListener('close', () => {
            console.warn("🚪 WebSocket closed — clearing game state.");
            clearGameState();
        });

        ws.addEventListener('open', () => {
            console.log("🔌 WebSocket reconnected — waiting for next hand.");
        });

        return ws;
    };

    window.WebSocket.prototype = OriginalWebSocket.prototype;
    window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    window.WebSocket.OPEN = OriginalWebSocket.OPEN;
    window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
    window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();


function handleGameState(messageObj) {
    const chatData = messageObj.data;
    const message = chatData.message;
    const author = chatData.author;
    //console.log("handleCommunityCardChat():", messageObj);

    // New Game - Get ID and Reset game data
    if (message.includes("started")) {
        clearGameState();
        const gameId = message.split(" ")[0];
        pokerData.GameID = gameId;
        console.log("Game started, ID:", gameId);
    }

    if (pokerData.GameID === null) {
        console.log("Waiting for new game to start");
        return;
    }

    // PreFlop
    if (message.includes("Two cards dealt to each player")) {
        pokerData.round = "Round 1";
        console.log(`[${pokerData.round}] Two cards dealt to each player`);
        setTimeout(() => {
            const myCards = getMyHoleCardsFormatted();
            pokerData.myCards = myCards;
            console.log("My Cards:", myCards.join(", "));
            updateHUDDisplay();
        }, 500); // allow render time
        updateHUDDisplay();
        return;
    }

    if (author.includes("flop")) {
        pokerData.round = "Round 2"; // Flop
    }
    else if (author.includes("turn") && pokerData.round === "Round 2") {
        pokerData.round = "Round 3"; // Turn
    }
    else if (author.includes("river") && pokerData.round === "Round 3") {
        pokerData.round = "Round 4"; // River
    }

    if (message.includes("reveals")) {
        console.log(author, message);
        return;
    }

    // Detect cards
    const cards = message.match(/(10|[2-9]|J|Q|K|A)(hearts|spades|clubs|diamonds)/g);
    if (!cards) return;
    for (const card of cards) {
        if (!pokerData.communityCards.includes(card)) {
            pokerData.communityCards.push(card);
        }
    }

    console.log(`[${pokerData.round}] ${author}| Cards: ${pokerData.communityCards.join(", ")}`);
}

function getMyHoleCardsFormatted() {
    const playerArea = document.querySelector("[class*='playerMeGateway']");
    if (!playerArea) return [];

    const cardElements = playerArea.querySelectorAll("div[class*='front'] > div");
    const cards = Array.from(cardElements).map(e => {
        const classList = Array.from(e.classList);

        // Look for class that matches "suit-value" (e.g., diamonds-8___xyz)
        const raw = classList.find(cls => /^(hearts|spades|clubs|diamonds)-\d+/.test(cls));
        if (!raw) return null;

        const match = raw.match(/(hearts|spades|clubs|diamonds)-(\d+)/);
        if (!match) return null;

        const [, suit, valueRaw] = match;

        let value = valueRaw;
        value = value.replace("14", "A")
                     .replace("13", "K")
                     .replace("12", "Q")
                     .replace("11", "J");

        return `${value}${suit}`; // e.g., "Khearts"
    }).filter(Boolean);

    return cards;
}



// Refresh Data for new round
function clearGameState() {
    pokerData.hands = [];
    pokerData.round = null;
    pokerData.lastRaisePlayerID = null;
    pokerData.handInProgress = false;
    pokerData.seatedPlayerIDs = [];
    pokerData.lastPlayerStates = {};
    pokerData.activePlayerIDs = [];
    pokerData.communityCards = [];
    pokerData.myCards = [];
    pokerData.allowTracking = false;
    pokerData.revealedPlayers = new Set();
    pokerData.wtsdCountedThisHand = new Set();

    console.log("🔄 Game State Cleared");
}

// Function to download pokerData as JSON
function downloadPokerData() {
    const blob = new Blob([JSON.stringify(pokerData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `poker_data_${Date.now()}.json`;
    a.click();
}

// Add HUD overlay to the page
function initHUD() {
    const hud = document.createElement('div');
    hud.id = 'poker-hud';
    hud.style.position = 'fixed';
    hud.style.top = '10px';
    hud.style.right = '10px';
    hud.style.width = '300px';
    hud.style.maxHeight = '900px';
    hud.style.overflowY = 'auto';
    hud.style.zIndex = '9999';
    hud.style.background = 'rgba(0, 0, 0, 0.8)';
    hud.style.color = '#fff';
    hud.style.padding = '10px';
    hud.style.borderRadius = '8px';
    hud.style.fontFamily = 'monospace';
    hud.style.overflowY = "auto";
    hud.style.overflowX = "hidden";

    hud.innerHTML = `<h3 style="margin-top: 0;">Poker HUD</h3><div id="hud-content">Loading...</div>`;

    // ✅ Append buttons
    hud.insertAdjacentHTML("beforeend", `
        <div style="margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
            <button id="export-btn" style="flex:1;">⬇ Export Data</button>
            <button id="import-btn" style="flex:1;">⬆ Import Data</button>
            <button id="clear-btn" style="flex:1;">🗑️ Clear Data</button>
            <input type="file" id="import-file" style="display: none;" />
        </div>
    `);

    document.body.appendChild(hud);

    // Export button logic
    document.getElementById("export-btn").addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(pokerData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `poker_data_${Date.now()}.json`;
        a.click();
    });

    // Import button logic
    document.getElementById("import-btn").addEventListener("click", () => {
        document.getElementById("import-file").click();
    });

    document.getElementById("import-file").addEventListener("change", function () {
        const file = this.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const importedData = JSON.parse(e.target.result);
                Object.assign(pokerData.players, importedData.players || {});
                pokerData.hands = importedData.hands || [];
                pokerData.communityCards = importedData.communityCards || [];
                updateHUDDisplay();
                saveHUDData();
            } catch (err) {
                alert("Invalid JSON file.");
            }
        };
        reader.readAsText(file);
    });

    // Clear Data button logic
    document.getElementById("clear-btn").addEventListener("click", clearPokerData);

    const style = document.createElement("style");
    style.innerHTML = `
        #poker-hud button {
            background-color: #222;
            color: #fff;
            border: 1px solid #555;
            padding: 6px 10px;
            font-size: 14px;
            border-radius: 5px;
            cursor: pointer;
            transition: background-color 0.2s ease;
        }

        #poker-hud button:hover {
            background-color: #444;
        }

        #poker-hud {
            scrollbar-width: thin;
        }

        #poker-hud::-webkit-scrollbar {
            width: 6px;
        }

        #poker-hud::-webkit-scrollbar-thumb {
            background: #555;
            border-radius: 4px;
        }
    `;
    document.head.appendChild(style);
}

function updateHUDDisplay() {
    const content = document.getElementById('hud-content');
    if (!content) return;

    const playerStats = pokerData.players;
    const activeIDs = pokerData.activePlayerIDs || [];

    let html = "";
    activeIDs.forEach(id => {
        const p = playerStats[id];
        if (!p) return;

        const hands = p.handsPlayed || 0;
        const winnings = p.totalWinnings || 0;
        const spent = p.totalSpent || 0;
        const netWinnings = winnings - spent;

        let displayWinnings, unit;
        if (Math.abs(netWinnings) >= 1_000_000_000) {
            displayWinnings = (netWinnings / 1_000_000_000).toFixed(2);
            unit = "B";
        } else {
            displayWinnings = (netWinnings / 1_000_000).toFixed(2);
            unit = "M";
        }

        const aggressionFactor = p.actions.call > 0 ? ((p.actions.bet + p.actions.raise) / p.actions.call).toFixed(2) : "∞";
        const vpip = hands > 0 ? ((p.vpipHands / hands) * 100).toFixed(1) : "0.0";
        const pfr = hands > 0 ? ((p.actions.raise / hands) * 100).toFixed(1) : "0.0";
        const wtsd = hands > 0 ? ((p.showdownSeen / hands) * 100).toFixed(1) : "0.0";
        const wsd = p.showdownSeen > 0 ? Math.min(((p.showdownWon / p.showdownSeen) * 100), 100).toFixed(1) : "0.0";

        html += `
        <div style="margin-bottom: 12px; border-bottom: 1px solid #555; padding-bottom: 8px;">
            <strong>${p.name}</strong><br>
        </div>
    `;
    });

    content.innerHTML = html || "<i>Waiting for new round to start</i>";
}

function clearPokerData() {
    if (confirm("Are you sure you want to clear all Poker HUD data?")) {
        localStorage.removeItem("pokerHudData");
        pokerData.players = {};
        pokerData.hands = [];
        pokerData.communityCards = [];
        pokerData.activePlayerIDs = [];
        updateHUDDisplay();
        alert("✅ Poker HUD data cleared!");
    }
}

// Save to localStorage
function saveHUDData() {
    localStorage.setItem("pokerHudData", JSON.stringify(pokerData));
}

// Load from localStorage
function loadHUDData() {
    const saved = localStorage.getItem("pokerHudData");
    if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(pokerData.players, parsed.players || {});
        pokerData.hands = parsed.hands || [];
        pokerData.communityCards = parsed.communityCards || [];
        pokerData.activePlayerIDs = parsed.activePlayerIDs || [];
    }
}


// Run every few seconds to refresh stats
setInterval(() => {
    updateHUDDisplay();
    saveHUDData();
}, 3000);


// Run on page load
window.addEventListener("load", () => {
    initHUD();
    loadHUDData();
});