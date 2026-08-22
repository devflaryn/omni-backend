-- ============================================================================
--  OMNI-EXEC — shared state for every module that follows.
--
--  The ui/*.lua files are concatenated into ONE Luau chunk by
--  omniExec.middleware.js, in filename order, and wrapped in a single pcall.
--  So the split is a FILE split, not a SCOPE split: a `local` declared here is
--  visible to every module after it, and the modules are separate files for
--  the sake of whoever has to edit them rather than for the runtime.
--
--  Which is also why so little here is a top-level local. Luau caps a function
--  at 200 locals and the chunk IS a function, so anything not needed by name
--  hangs off `OMNI` instead of spending one of them.
-- ============================================================================

-- Satisfy the executor's watchdogs. They spin waiting on these, and we replaced
-- the whole menu, so the real init.lua that would have set them never loads.
pcall(function() getgenv().initLoaded = true end)
pcall(function() getgenv().arceus = getgenv().arceus or {} end)
pcall(function() getgenv().ax = getgenv().arceus end)

local Players = game:GetService("Players")
local UIS     = game:GetService("UserInputService")
local TweenS  = game:GetService("TweenService")
local RunS    = game:GetService("RunService")
local HttpS   = game:GetService("HttpService")
local CoreGui = game:GetService("CoreGui")

local OMNI = {}

OMNI.VERSION = "2.0.0"
OMNI.BASE    = "__OMNI_BASE__"          -- substituted by the middleware at serve time

OMNI.Players, OMNI.UIS, OMNI.TweenS = Players, UIS, TweenS
OMNI.RunS, OMNI.HttpS = RunS, HttpS

-- ---------------------------------------------------------------------------
-- WHERE ARE WE RUNNING?
--
-- Omnidroid writes a marker into the executor's workspace during boot; nothing
-- else does. `isfile` resolves against that workspace rather than against `/`
-- — the stock Arceus gist calls it the same way (`isfile("warning.data")`),
-- which is where the convention is confirmed.
--
-- THIS FAILS OPEN, and that direction is the whole point. "No marker" means
-- "generic device", which is the branch that always leaves a visible way into
-- the menu. A detection MISS therefore costs an unwanted button on a farming
-- instance; the inverse default would cost a paying customer their only route
-- into the product. Cheap mistake on one side, product-breaking on the other.
OMNI.MARKER = "omni_host.data"

local function detectOmnidroid()
    local ok, present = pcall(function()
        return isfile ~= nil and isfile(OMNI.MARKER) == true
    end)
    return (ok and present == true)
end

OMNI.isOmnidroid = detectOmnidroid()

-- The marker carries `omnidroid:<mode>`, so the status page can say which mode
-- this instance was booted in. Optional in every direction: `readfile` may not
-- exist, and an unreadable marker is not a reason to doubt a detection that has
-- already succeeded — it only costs one line of detail.
OMNI.hostDetail = nil
if OMNI.isOmnidroid then
    pcall(function()
        if readfile then
            local body = readfile(OMNI.MARKER)
            if type(body) == "string" and body ~= "" then
                OMNI.hostDetail = (body:gsub("%s+$", ""))
            end
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Runtime state. One table, read by the status page and written by everything
-- else, so "what is this instance doing" has exactly one answer to read.
OMNI.state = {
    startedAt   = os.time(),
    toggleShown = false,          -- has the floating toggle been promoted?
    bridge = {
        phase      = "starting",  -- starting | claiming | ready | running | error
        channel    = nil,
        claimed    = false,
        lastPollAt = nil,
        lastJob    = nil,         -- {id, ok, output, at}
        detail     = "",
    },
}

function OMNI.uptime()
    return math.max(0, os.time() - OMNI.state.startedAt)
end

function OMNI.uptimeText()
    local s = OMNI.uptime()
    local h, m = math.floor(s / 3600), math.floor((s % 3600) / 60)
    if h > 0 then return string.format("%dh %02dm", h, m) end
    if m > 0 then return string.format("%dm %02ds", m, s % 60) end
    return string.format("%ds", s)
end

-- ---------------------------------------------------------------------------
-- The one ScreenGui everything parents into. Protected container when the
-- executor offers one, CoreGui otherwise.
local parent = CoreGui
pcall(function() if gethui then parent = gethui() end end)

local previous = parent:FindFirstChild("OmniExecUI")
if previous then previous:Destroy() end

local gui = Instance.new("ScreenGui")
gui.Name = "OmniExecUI"
gui.ResetOnSpawn = false
gui.IgnoreGuiInset = true
gui.ZIndexBehavior = Enum.ZIndexBehavior.Global
gui.DisplayOrder = 1000000
gui.Parent = parent

OMNI.gui = gui

-- Viewport, read live rather than cached. The window sizes itself against this
-- and a farming guest's panel is 480x270 — a constant sized for a phone does
-- not fit on one, and the panel can change under us mid-session (the squeeze
-- issues `wm size`).
function OMNI.viewport()
    local cam = workspace.CurrentCamera
    if cam and cam.ViewportSize.X > 0 then return cam.ViewportSize end
    if gui.AbsoluteSize.X > 0 then return gui.AbsoluteSize end
    return Vector2.new(1280, 720)
end
