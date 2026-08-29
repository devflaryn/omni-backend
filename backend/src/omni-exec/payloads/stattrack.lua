-- ============================================================================
--  OMNI STAT TRACK — the in-game collector. PREMIUM.
--
--  Served as text from /omni/exec/stattrack.lua and loadstring()d by the tiny
--  autoexec file the desktop app writes into the host autoexec folder. The
--  indirection is deliberate: the collector can be fixed under a fleet that is
--  already running, and every guest reports to the server that handed it the
--  script rather than to whatever a baked-in constant used to say.
--
--  WHAT IT DOES. Once per session it claims a bridge token for this account,
--  then every ~20 s it reads whatever the game will show it and POSTs one
--  report. The server resolves the owner from the account name and refuses the
--  report outright if that owner has no active plan, at which point this stops
--  for good rather than retrying — a free account must not have a script
--  looping against the server forever.
--
--  WHAT IT DOES NOT DO. It never touches remotes, never writes to the game,
--  never reads another player. It reads its own player's own visible values.
--
--  ---- THE HARD PART: EVERY GAME STORES ITS MONEY SOMEWHERE ELSE ----
--
--  There is no Roblox-wide "currency" API. leaderstats is the closest thing to
--  a convention and plenty of big games (Pet Simulator 99 among them) do not
--  use it at all. So collection is a LAYERED GUESS, best source first, and the
--  first layer to produce a key wins:
--
--    1. leaderstats            what the game itself chose to display
--    2. player attributes      the modern equivalent, same intent
--    3. named value objects    a bounded sweep of the containers games keep
--                              per-player data in, filtered to currency-shaped
--                              names so a sweep cannot turn into a data dump
--    4. getgenv().OMNI_STATTRACK_EXTRA   a per-game override the user supplies
--
--  Layer 3 is a heuristic and is labelled as one in the payload (`source`), so
--  a number on the dashboard can always be traced to how it was found. A game
--  that hides its currency behind a remote is simply not tracked; inventing a
--  reading would be worse than an empty row.
-- ============================================================================

if getgenv and getgenv().__OMNI_STATTRACK then return end
if getgenv then getgenv().__OMNI_STATTRACK = true end

local BASE    = "__OMNI_BASE__"          -- substituted by execBridge at serve time
local VERSION = "1.0.0"

local Players     = game:GetService("Players")
local HttpS       = game:GetService("HttpService")

local httprequest = (syn and syn.request) or (http and http.request)
                    or http_request or request

local startedAt = os.time()

local function log(msg)
    pcall(function()
        if rconsoleprint then rconsoleprint("[OMNI stattrack] " .. tostring(msg) .. "\n") end
    end)
end

-- ---------------------------------------------------------------------------
-- COLLECTION
--
-- Names we accept from the bounded sweep. Matched case-insensitively as a
-- SUBSTRING, because games write "TotalGems", "gemsAmount" and "Gems" and all
-- three mean the same shelf. The list is the cost control: without it layer 3
-- would ship every IntValue a game keeps on a player, which is both a much
-- bigger payload and a much worse dashboard.
local CURRENCY_WORDS = {
    "gem", "coin", "cash", "money", "diamond", "token", "gold", "star",
    "candy", "ticket", "shard", "crystal", "point", "level", "xp", "exp",
    "rebirth", "strength", "power", "win", "kill", "rank", "hatch", "pet",
    "damage", "click", "steal", "bank", "trophy", "egg", "luck", "multiplier",
}

local function looksLikeCurrency(name)
    local lower = string.lower(tostring(name))
    for _, word in ipairs(CURRENCY_WORDS) do
        if string.find(lower, word, 1, true) then return true end
    end
    return false
end

local function isValueObject(inst)
    return inst:IsA("IntValue") or inst:IsA("NumberValue")
        or inst:IsA("StringValue") or inst:IsA("BoolValue")
end

-- One metric row. `display` is what the game showed; the server parses the
-- number out of it and keeps both, so "1.2M" stays readable AND chartable.
local function metric(out, seen, key, label, value, source)
    if key == nil or value == nil then return end
    local slug = string.lower(tostring(key))
    if seen[slug] then return end          -- first (best) source wins
    if type(value) == "table" then return end
    seen[slug] = true
    out[#out + 1] = {
        key = tostring(key),
        label = tostring(label or key),
        display = tostring(value),
        source = source,
    }
end

local function collectLeaderstats(player, out, seen)
    local stats = player:FindFirstChild("leaderstats")
    if not stats then return end
    for _, child in ipairs(stats:GetChildren()) do
        if isValueObject(child) then
            metric(out, seen, child.Name, child.Name, child.Value, "leaderstats")
        end
    end
end

local function collectAttributes(player, out, seen)
    local ok, attrs = pcall(function() return player:GetAttributes() end)
    if not ok or type(attrs) ~= "table" then return end
    for name, value in pairs(attrs) do
        if looksLikeCurrency(name) and type(value) ~= "table" then
            metric(out, seen, name, name, value, "attribute")
        end
    end
end

-- The bounded sweep. DEPTH 2 and a node budget, both load-bearing: a game with
-- a deep per-player folder tree would otherwise cost a full recursive walk of
-- it every twenty seconds, on a guest that is already CPU-starved because it
-- is one of twenty-five VMs on the box.
local SWEEP_DEPTH = 2
local SWEEP_BUDGET = 400

local function sweep(root, out, seen, depth, budget)
    if not root or depth > SWEEP_DEPTH then return budget end
    for _, child in ipairs(root:GetChildren()) do
        if budget <= 0 then return 0 end
        budget = budget - 1
        if isValueObject(child) then
            if looksLikeCurrency(child.Name) then
                metric(out, seen, child.Name, child.Name, child.Value, "found")
            end
        elseif child:IsA("Folder") or child:IsA("Configuration") or child:IsA("Model") then
            budget = sweep(child, out, seen, depth + 1, budget)
        end
    end
    return budget
end

local function collectSwept(player, out, seen)
    local budget = SWEEP_BUDGET
    -- The player itself, then the containers games conventionally park a
    -- per-player data folder in. Each is optional and each is pcall'd: a
    -- service this client cannot index must cost that container, not the report.
    budget = sweep(player, out, seen, 1, budget)
    for _, get in ipairs({
        function() return player:FindFirstChild("Data") end,
        function() return player:FindFirstChild("PlayerData") end,
        function() return player:FindFirstChild("Stats") end,
        function() return game:GetService("ReplicatedStorage"):FindFirstChild("PlayerData") end,
        function() return game:GetService("ReplicatedStorage"):FindFirstChild("Data") end,
    }) do
        if budget <= 0 then break end
        local ok, container = pcall(get)
        if ok and container then
            -- A shared container is keyed by player name; prefer that subtree.
            local mine = container:FindFirstChild(player.Name)
            budget = sweep(mine or container, out, seen, 1, budget)
        end
    end
end

-- The escape hatch. A user who knows where THEIR game keeps its numbers sets
-- getgenv().OMNI_STATTRACK_EXTRA to a function returning {Gems = 123}; it runs
-- LAST so it can add what the layers above missed, and its failure is caught
-- so a bad override costs its own values and nothing else.
local function collectExtra(out, seen)
    local hook = getgenv and getgenv().OMNI_STATTRACK_EXTRA
    if type(hook) ~= "function" then return end
    local ok, extra = pcall(hook)
    if not ok or type(extra) ~= "table" then return end
    for name, value in pairs(extra) do
        metric(out, seen, name, name, value, "custom")
    end
end

local function collect(player)
    local out, seen = {}, {}
    pcall(collectLeaderstats, player, out, seen)
    pcall(collectAttributes, player, out, seen)
    pcall(collectSwept, player, out, seen)
    pcall(collectExtra, out, seen)
    return out
end

-- ---------------------------------------------------------------------------
-- TRANSPORT
--
-- POST when the executor gives us one (the full report, no length limit worth
-- worrying about), GET otherwise. The GET form is not a nicety: this build's
-- executor does not always expose request(), and the remote-execute bridge
-- learned the same lesson the hard way — see 80_bridge.lua.
local function post(url, bodyTable)
    if not httprequest then return nil end
    local ok, res = pcall(function()
        return httprequest({
            Url = url,
            Method = "POST",
            Headers = { ["Content-Type"] = "application/json" },
            Body = HttpS:JSONEncode(bodyTable),
        })
    end)
    if not ok or type(res) ~= "table" then return nil end
    return res.Body or res.body
end

local function get(url)
    local ok, body = pcall(function() return game:HttpGet(url, true) end)
    if ok and type(body) == "string" then return body end
    return nil
end

local function decode(body)
    if type(body) ~= "string" or body == "" then return nil end
    local parsed
    pcall(function() parsed = HttpS:JSONDecode(body) end)
    return parsed
end

-- ---------------------------------------------------------------------------
-- THE LOOP
task.spawn(function()
    while not Players.LocalPlayer do task.wait(0.4) end
    local player  = Players.LocalPlayer
    local channel = tostring(player.Name)

    -- A token is what makes a report attributable. Claim over HttpGet only:
    -- the claim endpoint has a GET twin precisely because HttpGet is the one
    -- call every executor provides.
    local token
    for attempt = 1, 30 do
        local parsed = decode(get(BASE .. "/omni/exec/claim?channel=" .. HttpS:UrlEncode(channel)))
        if parsed and parsed.token then
            token = parsed.token
            break
        end
        log("claim attempt " .. attempt .. " failed; retrying")
        task.wait(4)
    end
    if not token then
        log("could not claim a session; stat track is off for this session")
        return
    end
    log("tracking " .. channel)

    local executorName = "unknown"
    pcall(function()
        if identifyexecutor then executorName = tostring((identifyexecutor())) end
    end)

    local placeName
    pcall(function()
        placeName = game:GetService("MarketplaceService")
            :GetProductInfo(game.PlaceId).Name
    end)

    local interval = 20

    while true do
        local report = {
            t             = token,
            userId        = player.UserId,
            displayName   = tostring(player.DisplayName or player.Name),
            placeId       = tostring(game.PlaceId),
            placeName     = placeName,
            jobId         = tostring(game.JobId),
            uptimeSec     = os.time() - startedAt,
            executor      = executorName,
            scriptVersion = VERSION,
            metrics       = collect(player),
        }

        local answer = decode(post(BASE .. "/omni/exec/stats", report))
        if not answer then
            -- GET fallback. The payload is JSON in a query parameter and the
            -- server caps its length, so trim the metric list rather than let
            -- the server reject the whole report: a short report beats none.
            while #report.metrics > 12 do table.remove(report.metrics) end
            local encoded
            pcall(function() encoded = HttpS:JSONEncode(report) end)
            if encoded then
                answer = decode(get(BASE .. "/omni/exec/stats?t=" .. HttpS:UrlEncode(token)
                                    .. "&payload=" .. HttpS:UrlEncode(encoded)))
            end
        end

        if answer then
            if answer.stop then
                -- The server said don't come back (no plan, or the account is
                -- not registered). Honour it: retrying would be a loop nobody
                -- can switch off from the server side.
                log("stopping: " .. tostring(answer.message or answer.error or "server said stop"))
                return
            end
            if answer.ok then
                if tonumber(answer.nextInSec) then interval = tonumber(answer.nextInSec) end
            else
                log("report refused: " .. tostring(answer.error))
            end
        end

        task.wait(interval)
    end
end)
