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
    players: {},
    round: null,
    seatedPlayerIDs: [],
    activePlayerIDs: [],
    communityCards: [],
    myCards: [],
    preflopRaisers: [],
    preflopRaiseCount: 0,
    GameID: null,
    TableID: null,
    TableName: null,
    bbPlayerName: null,
    bbPlayerID: null,
    bbAmount: null,
    sbPlayerName: null,
    sbPlayerID: null,
    sbAmount: null,
};

const blindPosts = [];

const db = new Dexie("PokerHUD");
db.version(3).stores({
    players: "&id, name, handsPlayed, vpipHands, pfrHands, facedPFR,threeBetHands, fourBetHands, facedThreeBetHands, foldedToThreeBetHands, netProfit, lastPlayed, GameID, TableID, [id+TableID]"
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
                if (!isJsonString(msg)) return;

                const data = JSON.parse(msg);
                const channel = data?.push?.channel;
                if (!channel || !channel.startsWith('holdem')) return;

                const message = data?.push?.pub?.data?.message;

                // Detect table change
                const isTableChannel = /^holdem\d+$/.test(channel);
                if (isTableChannel) {
                    const newTableID = channel.replace(/\D+/g, '');

                    if (pokerData.TableID && pokerData.TableID !== newTableID) {
                        console.log(`🪑 Table change detected! ${pokerData.TableID} ➡ ${newTableID}`);
                        clearGameState();
                    }

                    pokerData.TableID = newTableID;
                }


                // Get table name from lobby info
                if (channel.includes('holdemlobby')) {
                    const tables = data?.push?.pub?.data?.message?.tables;
                    const currentID = Number(pokerData.TableID);
                    const matchingTable = tables?.find(t => t.ID === currentID);
                    pokerData.TableName = matchingTable?.name || `Table ${currentID}`;
                }

                if (!message) return;

                // Route based on event type
                switch (message.eventType) {
                    case "getState":
                        handleGetState(message);
                        break;
                    case "playerMakeMove":
                        break;
                    case "chat":
                        const chat = message.data;
                        if (chat.meta === "action" || chat.meta === "won") {
                            handlePlayerAction(message);
                        } else if (chat.meta === "state") {
                            handleGameState(message);
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


function handleGetState(messageobj) {
    //console.log(messageobj);

    if (messageobj.hand) {
        const hand = messageobj?.hand;

        if (!hand || !Array.isArray(hand)) {
            console.warn("No hand data found.");
            return;
        }

        const valueMap = {
            "14": "A",
            "13": "K",
            "12": "Q",
            "11": "J"
        };

        const formattedHand = hand.map(card => {
            const [suit, value] = card.split("-");
            const displayValue = valueMap[value] || value;
            return `${displayValue}${suit}`; // e.g., "Kspades"
        });

        pokerData.myCards = formattedHand;
        //console.log("My Cards:", formattedHand.join(", "));
    }

    if (messageobj.players && typeof messageobj.players === "object") {

        for (const player of Object.values(messageobj.players)) {
            const { userID, playername } = player;
            if (!userID || !playername) continue;

            pokerData.players[userID] = {
                name: playername,
                money: null,
                vpipThisHand: false,
                pfrThisHand: false,
                actions: []
            };

            pokerData.seatedPlayerIDs.push(userID);
        }

        //console.log("Seated players:", pokerData.seatedPlayerIDs.map(id => pokerData.players[id].name).join(", "));

        for (const blind of blindPosts) {
            const player = Object.values(pokerData.players).find(p => p.name === blind.playerName);
            if (!player) continue;

            player.actions.push({
                type: `posted ${blind.type} blind`,
                amount: blind.amount,
                round: pokerData.round || "Round 1",
                timestamp: Date.now()
            });

            player.money = (player.money || 0) - blind.amount;

            if (blind.type === "small") {
                pokerData.sbPlayerName = player.name;
                pokerData.sbAmount = blind.amount;
            } else if (blind.type === "big") {
                pokerData.bbPlayerName = player.name;
                pokerData.bbAmount = blind.amount;
            }

            console.log(`${player.name} posted ${blind.type} blind: $${blind.amount}`);
        }

        // Clear the queue after applying
        blindPosts.length = 0;
    }

    updateHUDDisplay();
}

function handlePlayerAction(messageObj) {
    const chatData = messageObj.data;
    const message = chatData.message;
    const author = chatData.author;
    const userID = chatData.userID;

    if (pokerData.GameID === null) {
        return;
    }
    if (chatData.meta.includes("action")) {

        if (message.includes("posted small blind")) {
            const playerName = chatData.author;
            const match = message.match(/\$([\d,]+)/);
            const amount = match ? parseInt(match[1].replace(/,/g, '')) : 0;
            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.money = (playerEntry.money || 0) - amount;
            }

            blindPosts.push({
                type: "small",
                playerName,
                amount
            });
        }

        if (message.includes("posted big blind")) {
            const playerName = chatData.author;
            const match = message.match(/\$([\d,]+)/);
            const amount = match ? parseInt(match[1].replace(/,/g, '')) : 0;
            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.money = (playerEntry.money || 0) - amount;
            }


            blindPosts.push({
                type: "big",
                playerName,
                amount
            });
        }

        if (message.includes("raised $")) {
            console.log(message);
            const playerName = chatData.author;
            let raiseTo = 0;
            let match = message.match(/to\s+\$([\d,]+)/i); // Try "to $4096"
            if (!match) match = message.match(/raised\s+\$([\d,]+)/i); // Fallback: "raised $4096"
            raiseTo = match ? parseInt(match[1].replace(/,/g, '')) : 0;
            

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "raise",
                    amount: raiseTo,
                    round: pokerData.round,
                    timestamp: Date.now()
                });

                playerEntry.money = (playerEntry.money || 0) - raiseTo;

                if (pokerData.round === "Round 1") {
                    pokerData.preflopRaiseCount++;
                    playerEntry.vpipThisHand = true;
                    if (pokerData.preflopRaiseCount === 1) {
                        playerEntry.pfrThisHand = true;
                    } else if (pokerData.preflopRaiseCount === 2) {
                        playerEntry.threeBetThisHand = true;
                        console.log(`${playerName} made a 3-bet!`);
                    } else if (pokerData.preflopRaiseCount === 3) {
                        playerEntry.fourBetThisHand = true;
                        console.log(`${playerName} made a 4-bet!`);
                    }
                
                    if (!pokerData.preflopRaisers.includes(playerName)) {
                        pokerData.preflopRaisers.push(playerName);
                    }
                }

                if (!playerEntry.aggressionStats) {
                    playerEntry.aggressionStats = { bets: 0, raises: 0, calls: 0 };
                } 
                playerEntry.aggressionStats.raises++;               

                //console.log(`${playerName} raised to $${raiseTo}`);
            }
        }

        if (message.includes("called $")) {
            console.log(message);
            const playerName = chatData.author;
            const match = message.match(/\$([\d,]+)/);
            const calledAmount = match ? parseInt(match[1].replace(/,/g, '')) : 0;

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "called",
                    amount: calledAmount,
                    round: pokerData.round,
                    timestamp: Date.now()
                });

                playerEntry.money = (playerEntry.money || 0) - calledAmount;

                if (pokerData.round === "Round 1" && !playerEntry.vpipThisHand) {
                    playerEntry.vpipThisHand = true;
                }

                if (!playerEntry.aggressionStats) {
                    playerEntry.aggressionStats = { bets: 0, raises: 0, calls: 0 };
                } 
                playerEntry.aggressionStats.calls++;    

                //console.log(`${playerName} called $${calledAmount}`);
            }
        }

        if (message.includes("bet $")) {
            console.log(message);
            const playerName = chatData.author;
            const match = message.match(/\$([\d,]+)/);
            const betAmount = match ? parseInt(match[1].replace(/,/g, '')) : 0;

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "bet",
                    amount: betAmount,
                    round: pokerData.round,
                    timestamp: Date.now()
                });

                playerEntry.money = (playerEntry.money || 0) - betAmount;

                if (pokerData.round === "Round 1" && !playerEntry.vpipThisHand) {
                    playerEntry.vpipThisHand = true;
                }

                if (!playerEntry.aggressionStats) {
                    playerEntry.aggressionStats = { bets: 0, raises: 0, calls: 0 };
                } 
                playerEntry.aggressionStats.bets++;    

                //console.log(`${playerName} bet $${betAmount}`);
            }
        }

        if (message.includes("folded")) {
            const playerName = chatData.author;

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "folded",
                    round: pokerData.round,
                    timestamp: Date.now()
                });
                //console.log(`${playerName} folded`);
            }
        }

        if (message.includes("checked")) {
            const playerName = chatData.author;

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "checked",
                    round: pokerData.round,
                    timestamp: Date.now()
                });
                //console.log(`${playerName} checked`);
            }
        }
    } else if (chatData.meta.includes("won")) {
        console.log(message);
        if (message.includes("won $")) {
            const playerName = chatData.author;
            const match = message.match(/\$([\d,]+)/);
            const amount = match ? parseInt(match[1].replace(/,/g, '')) : 0;

            const playerEntry = Object.values(pokerData.players).find(p => p.name === playerName);
            if (playerEntry) {
                playerEntry.actions.push({
                    type: "won",
                    amount: amount,
                    round: pokerData.round,
                    timestamp: Date.now()
                });

                playerEntry.money = (playerEntry.money || 0) + amount;
                //console.log(`${playerName} won $${amount}`);
            }
            commitHandStatsToIndexedDB();
        }
    }
}

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
        //console.log(author, message);
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

// Refresh Data for new round
function clearGameState() {
    //logPlayerActions();

    pokerData.round = null;
    pokerData.GameID = null;
    pokerData.TableID = null;
    pokerData.seatedPlayerIDs = [];
    pokerData.activePlayerIDs = [];
    pokerData.communityCards = [];
    pokerData.preflopRaisers = [];
    pokerData.preflopRaiseCount = 0;
    pokerData.myCards = [];
    pokerData.sbAmount = null;
    pokerData.sbPlayerName = null;
    pokerData.sbPlayerID = null;
    pokerData.bbAmount = null;
    pokerData.bbPlayerName = null;
    pokerData.bbPlayerID = null;
    pokerData.players = {};

    blindPosts.length = 0;

    console.log("🔄 Game State Cleared");
}

function logPlayerActions() {
    console.log("🔍 Player Actions This Hand:");

    pokerData.seatedPlayerIDs.forEach(userID => {
        const player = pokerData.players[userID];
        if (!player) return;

        console.log(`🧑 ${player.name}:`);

        if (!player.actions || player.actions.length === 0) {
            console.log("   • No actions recorded.");
            return;
        }

        player.actions.forEach(action => {
            const time = new Date(action.timestamp).toLocaleTimeString();
            const amount = action.amount !== undefined ? ` $${action.amount.toLocaleString()}` : '';
            console.log(`   • [${action.round}] ${action.type}${amount} @ ${time}`);
        });
    });

    console.log("──────────────────────────────");
}

async function commitHandStatsToIndexedDB() {
    if (!pokerData.GameID) {
        console.error("Invalid hand data: Missing GameID");
        return;
    }

    console.log("Committing hand stats:", pokerData.players);

    const dbOperations = Object.entries(pokerData.players)
    .filter(([_, playerData]) => Array.isArray(playerData.actions) && playerData.actions.length > 0)
    .map(async ([playerID, playerData]) => {
        
        const vpipIncrement = playerData.vpipThisHand ? 1 : 0;
        const pfrIncrement = playerData.pfrThisHand ? 1 : 0;
        const fourBetIncrement = playerData.fourBetThisHand ? 1 : 0;
        const handNetProfit = playerData.money || 0;

        let faced3B = false;
        let foldedTo3B = false;
        let facedPFRIncrement = 0;
        let threeBetIncrement = 0;

        const playerActions = playerData.actions || [];
        const preflopActions = playerActions.filter(a => a.round === "Round 1");

        const allPreflopRaises = pokerData.seatedPlayerIDs
            .map(id => {
                const player = pokerData.players[id];
                const raise = player?.actions?.find(a => a.type === "raise" && a.round === "Round 1");
                return raise ? { id, name: player.name, timestamp: raise.timestamp } : null;
            })
            .filter(r => r !== null)
            .sort((a, b) => a.timestamp - b.timestamp);

        const playerPreflopRaise = preflopActions.find(a => a.type === "raise");

        if (playerPreflopRaise) {
            const isFirstRaiser = allPreflopRaises[0]?.name === playerData.name;

            if (!isFirstRaiser) {
                facedPFRIncrement = 1;
                threeBetIncrement = 1;
            }

            if (isFirstRaiser && allPreflopRaises.length >= 2) {
                faced3B = true;
                const foldedPreflop = playerData.actions.some(a => a.type === "folded" && a.round === "Round 1");
                if (foldedPreflop) {
                    foldedTo3B = true;
                }
            }
        } else {
            const firstAction = preflopActions[0];
            if (firstAction && allPreflopRaises.length > 0 && firstAction.timestamp > allPreflopRaises[0].timestamp) {
                facedPFRIncrement = 1;
            }
        }
        if (playerData.fourBetThisHand && !faced3B) {
            //cold 4bet
            faced3B = true;
        } else if (playerData.fourBetThisHand && faced3B) {
            fourBetIncrement = 1;
        }

        try {
            const playerIDString = String(playerID).trim();
            const existingRecord = await db.players.where('[id+TableID]').equals([playerIDString, pokerData.TableID]).first();

            await db.players.put({
                id: playerIDString,  
                TableID: pokerData.TableID,
                name: playerData.name,
                handsPlayed: (existingRecord?.handsPlayed || 0) + 1,
                vpipHands: (existingRecord?.vpipHands || 0) + vpipIncrement,
                pfrHands: (existingRecord?.pfrHands || 0) + pfrIncrement,
                threeBetHands: (existingRecord?.threeBetHands || 0) + threeBetIncrement,
                fourBetHands: (existingRecord?.fourBetHands || 0) + fourBetIncrement,
                facedPFR: (existingRecord?.facedPFR || 0) + facedPFRIncrement,
                facedThreeBetHands: (existingRecord?.facedThreeBetHands || 0) + (faced3B ? 1 : 0),
                foldedToThreeBetHands: (existingRecord?.foldedToThreeBetHands || 0) + (foldedTo3B ? 1 : 0),
                netProfit: (existingRecord?.netProfit || 0) + handNetProfit,
                lastPlayed: Date.now(),
                GameID: pokerData.GameID,
                aggressionStats: {
                    bets: (existingRecord?.aggressionStats?.bets || 0) + (playerData.aggressionStats?.bets || 0),
                    raises: (existingRecord?.aggressionStats?.raises || 0) + (playerData.aggressionStats?.raises || 0),
                    calls: (existingRecord?.aggressionStats?.calls || 0) + (playerData.aggressionStats?.calls || 0),
                },                
            });
        } catch (e) {
            console.error(`Error updating player ${playerData.name} (${playerID}):`, e);
        }
    });

    try {
        await Promise.all(dbOperations);
        console.log("IndexedDB updated successfully for all players this hand.");
    } catch (e) {
        console.error("Unexpected error committing hand stats:", e);
    }
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

    hud.innerHTML = `<h3 style="margin-top: 0;" id="hud-title">Loading table info...</h3><div id="hud-content">Loading...</div>`;

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

        #poker-hud .profit-positive {
        color: #00e676; /* lime green */
        font-weight: bold;
        }
        #poker-hud .profit-negative {
            color: #ef5350; /* soft red */
            font-weight: bold;
        }
        #poker-hud .vpip-nit {
        color: #888; /* grey */
        }
        #poker-hud .vpip-tag {
            color: #4caf50; /* green */
            font-weight: bold;
        }
        #poker-hud .vpip-semi {
            color: #fdd835; /* yellow */
        }
        #poker-hud .vpip-loose {
            color: #ff9800; /* orange */
        }
        #poker-hud .vpip-maniac {
            color: #ef5350; /* red */
            font-weight: bold;
        }
        #poker-hud .pfr-good {
            color: #4caf50; /* green */
            font-weight: bold;
        }
        #poker-hud .pfr-okay {
            color: #fdd835; /* yellow */
        }
        #poker-hud .pfr-passive {
            color: #ef5350; /* red */
        }
        #poker-hud .pfr-overaggro {
            color: #ff9800; /* orange */
        }
        #poker-hud .pfr-undefined {
            color: #888; /* grey */
        }
        #poker-hud .af-zero {
            color: #888; /* grey */
        }
        #poker-hud .af-passive {
            color: #ef5350; /* red */
        }
        #poker-hud .af-balanced {
            color: #4caf50; /* green */
            font-weight: bold;
        }
        #poker-hud .af-aggressive {
            color: #ff9800; /* orange */
        }
        #poker-hud .af-maniac {
            color: #ab47bc; /* purple */
        }
        #poker-hud .af-infinite {
            color: #00e5ff; /* cyan */
            font-weight: bold;
        }
            #poker-hud .threeb-nit {
            color: #888; /* grey */
        }
        #poker-hud .threeb-standard {
            color: #4caf50; /* green */
            font-weight: bold;
        }
        #poker-hud .threeb-aggro {
            color: #ff9800; /* orange */
        }
        #poker-hud .threeb-maniac {
            color: #ef5350; /* red */
            font-weight: bold;
        }
        #poker-hud .threeb-undefined {
            color: #888; /* fallback grey */
        }
            #poker-hud .fourb-nit {
            color: #aaa;
        }
        #poker-hud .fourb-solid {
            color: #4caf50;
            font-weight: bold;
        }
        #poker-hud .fourb-aggro {
            color: #ff9800;
        }
        #poker-hud .fourb-maniac {
            color: #ef5350;
            font-weight: bold;
        }
        #poker-hud .fourb-undefined {
            color: #888;
        }
        #poker-hud .f3b-undefined {
            color: #aaa; /* light grey */
        }
        #poker-hud .f3b-foldy {
            color: #ccc; /* dull grey */
        }
        #poker-hud .f3b-tight {
            color: #ef5350; /* red */
            font-weight: bold;
        }
        #poker-hud .f3b-balanced {
            color: #4caf50; /* green */
            font-weight: bold;
        }
        #poker-hud .f3b-sticky {
            color: #ff9800; /* orange */
        }
        #poker-hud .f3b-aggro {
            color: #ab47bc; /* purple */
            font-weight: bold;
        }
    `;
    document.head.appendChild(style);
}

async function updateHUDDisplay() {
    const content = document.getElementById('hud-content');
    if (!content || !pokerData.TableID) return;

    const title = document.getElementById("hud-title");
    if (title) {
        const sb = pokerData.sbAmount !== null ? `$${formatCurrencyShort(pokerData.sbAmount)}` : "?";
        const bb = pokerData.bbAmount !== null ? `$${formatCurrencyShort(pokerData.bbAmount)}` : "?";
        const tableName = pokerData.TableName || `Table ${pokerData.TableID || '?'}`;
        title.textContent = `${tableName} (${sb}/${bb})`;        
    }


    const playersOnTable = pokerData.seatedPlayerIDs;
    if (!playersOnTable || playersOnTable.length === 0) {
        content.innerHTML = "<i>No players seated.</i>";
        return;
    }

    // Explicitly cast and trim IDs
    const playerIDsAsStrings = playersOnTable.map(id => String(id).trim());

    // Fetch all player records from IndexedDB
    const playerRecords = await Promise.all(
        playerIDsAsStrings.map(async id => {
            return await db.players
                .where('[id+TableID]')
                .equals([id, pokerData.TableID])
                .first();
        })
    );
    
    
    let html = "";
    playerRecords.forEach((record, index) => {
        const playerID = playerIDsAsStrings[index];
        const p = record || {
            name: pokerData.players[playerID]?.name || 'Unknown',
            handsPlayed: 0,
            vpipHands: 0,
            netProfit: 0,
        };

        const hands = p.handsPlayed || 0;
        const vpipPercent = hands > 0 ? ((p.vpipHands / hands) * 100).toFixed(1) : "0.0";
        const pfrPercent = hands > 0 ? ((p.pfrHands / hands) * 100).toFixed(1) : "0.0";
        const threeBetPercent = p.facedPFR > 0 ? ((p.threeBetHands / p.facedPFR) * 100).toFixed(1) : "0.0";
        const fourBetPercent = p.facedThreeBetHands > 0 ? ((p.fourBetHands || 0) / p.facedThreeBetHands * 100).toFixed(1) : "0.0";
        const f3bPercent = (p.facedThreeBetHands > 0)
        ? ((p.foldedToThreeBetHands / p.facedThreeBetHands) * 100).toFixed(1)
        : "0.0%";
        const netProfit = p.netProfit || 0;
        const bbAmount = pokerData.bbAmount || 1; // prevent division by 0
        const bbProfit = (netProfit / bbAmount).toFixed(1);
        const bbDisplay = `(${bbProfit} BB)`;
        const netDisplay = netProfit >= 0 
        ? `+$${formatCurrencyShort(netProfit)} ${bbDisplay}`
        : `-$${formatCurrencyShort(Math.abs(netProfit))} ${bbDisplay}`;    
        const netClass = netProfit >= 0 ? 'profit-positive' : 'profit-negative';
        const profileLink = `https://www.torn.com/profiles.php?XID=${playerID}`;
        const attackLink = `https://www.torn.com/loader.php?sid=attack&user2ID=${playerID}`;
        const aStats = p.aggressionStats || { bets: 0, raises: 0, calls: 0 };
        const totalAggressive = aStats.bets + aStats.raises;
        const calls = aStats.calls;
        const af = calls === 0 ? (totalAggressive > 0 ? "∞" : "0") : (totalAggressive / calls).toFixed(2);


        html += `
        <div style="padding: 10px 0; border-bottom: 1px solid #555; margin-bottom: 10px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span title="${getPlayerType(vpipPercent, pfrPercent, af)}" style="margin-right: 5px;">
                        ${getPlayerType(vpipPercent, pfrPercent, af).split(" ")[0]}
                    </span>
                    <a href="${profileLink}" target="_blank" style="color: #4FC3F7; text-decoration: none; font-weight: bold;">
                        ${p.name} [${playerID}]
                    </a>
                    <a href="${attackLink}" target="_blank" title="Attack Player" style="margin-left: 6px; text-decoration: none;">
                        🗡️
                    </a>
                </div>
                <div style="text-align: right; font-size: 14px; color: #ccc;">
                    Hands: ${hands}
                </div>
            </div>
            <div>
                Net Profit: <span class="${netClass}">${netDisplay}</span>
                <div style="font-family: monospace; margin-top: 4px;">
                    <!-- First row: VPIP, PFR, AF -->
                    <div style="display: flex; justify-content: space-between;">
                        <div style="width: 33%; text-align: left;">
                            <span class="${getVPIPClass(parseFloat(vpipPercent))}">VPIP: ${vpipPercent}%</span>
                        </div>
                        <div style="width: 33%; text-align: center;">
                            <span class="${getPFRClass(parseFloat(vpipPercent), parseFloat(pfrPercent))}">
                                PFR: ${pfrPercent}%
                            </span>
                        </div>
                        <div style="width: 33%; text-align: right;">
                            <span class="${getAFClass(af)}">AF: ${af}</span>
                        </div>
                    </div>

                    <!-- Second row: 3B, 4B, F3B -->
                    <div style="display: flex; justify-content: space-between; margin-top: 2px;">
                        <div style="width: 33%; text-align: left;">
                            <span class="${getThreeBetClass(threeBetPercent)}">3B: ${threeBetPercent}%</span>
                        </div>
                        <div style="width: 33%; text-align: center;">
                            <span class="${getFourBetClass(fourBetPercent)}">4B: ${fourBetPercent}%</span>
                        </div>
                        <div style="width: 33%; text-align: right;">
                            <span class="${getF3BClass(f3bPercent)}">F3B: ${f3bPercent}%</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        `;
    });

    content.innerHTML = html || "<i>Waiting for stats to populate...</i>";
}

function formatCurrencyShort(amount) {
    if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}b`;
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    return amount.toString();
}

function getVPIPClass(vpip) {
    if (vpip >= 40) return "vpip-maniac";
    if (vpip >= 30) return "vpip-loose";
    if (vpip >= 20) return "vpip-semi";
    if (vpip >= 10) return "vpip-tag";
    return "vpip-nit";
}

function getPFRClass(vpip, pfr) {
    if (vpip === 0) return "pfr-undefined"; // Prevent divide-by-zero
    const ratio = (pfr / vpip) * 100;
    if (ratio >= 70 && ratio <= 110) return "pfr-good";        // Green
    if (ratio >= 60 && ratio < 70) return "pfr-okay";          // Yellow
    if (ratio < 60) return "pfr-passive";                      // Red
    if (ratio > 110) return "pfr-overaggro";                   // Orange
    return "pfr-neutral";
}

function getAFClass(af) {
    if (af === "∞") return "af-infinite";
    const num = parseFloat(af);
    if (isNaN(num)) return "af-undefined";
    if (num === 0) return "af-zero";
    if (num <= 1) return "af-passive";
    if (num <= 3) return "af-balanced";
    if (num <= 6) return "af-aggressive";
    return "af-maniac";
}

function getThreeBetClass(threeBetPercent) {
    const pct = parseFloat(threeBetPercent);
    if (isNaN(pct)) return "threeb-undefined";
    if (pct < 3) return "threeb-nit";          // Grey
    if (pct < 6) return "threeb-standard";     // Green
    if (pct < 10) return "threeb-aggro";       // Yellow/Orange
    return "threeb-maniac";                    // Red
}

function getFourBetClass(fourBetPercent) {
    const pct = parseFloat(fourBetPercent);
    if (isNaN(pct)) return "fourb-undefined";
    if (pct < 1.5) return "fourb-nit";          // Grey
    if (pct < 3) return "fourb-solid";          // Green
    if (pct < 5) return "fourb-aggro";          // Orange
    return "fourb-maniac";                      // Red
}

function getF3BClass(f3bPercent) {
    const pct = parseFloat(f3bPercent);
    if (isNaN(pct)) return "f3b-undefined";
    if (pct > 80) return "f3b-foldy";         // Grey
    if (pct > 60) return "f3b-tight";          // Red
    if (pct > 40) return "f3b-balanced";       // Green
    if (pct > 20) return "f3b-sticky";         // Orange
    return "f3b-aggro";                        // Purple
}


function getPlayerType(vpip, pfr, af) {
    const v = parseFloat(vpip);
    const p = parseFloat(pfr);
    const a = af === "∞" ? 99 : parseFloat(af); // handle infinite AF

    if (v < 10 && p < 8 && a < 1.5) return "🪨 Nit : Very tight, rarely plays";
    if (v >= 10 && v <= 22 && p >= 8 && p <= 20 && a >= 1.5 && a <= 3) return "🧠 TAG : Tight-Aggressive";
    if (v > 22 && v <= 35 && p >= 18 && p <= 30 && a > 3) return "🧨 LAG : Loose-Aggressive";
    if (v >= 35 && p > 25 && a > 4) return "🔥 Maniac : Hyper-aggressive, bluffy";
    if (v >= 30 && p < 15 && a < 1.5) return "🐟 Fish : Loose-Passive, calling station";
    return "🤔 Unknown";
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

async function requestPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
        const isPersisted = await navigator.storage.persisted();
        if (!isPersisted) {
            const granted = await navigator.storage.persist();
            console.log(granted ? "✅ Persistent storage granted." : "❌ Persistent storage denied.");
        } else {
            console.log("📦 Already using persistent storage.");
        }
    } else {
        console.warn("⚠️ Persistent storage API not supported.");
    }
}

// Run on page load
window.addEventListener("load", () => {
    initHUD();
    loadHUDData();
    requestPersistentStorage();
});