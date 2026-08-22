-- ============================================================================
--  RUNNING LUAU. The one thing this product actually does.
--
--  Shared by the Script page and the remote-exec bridge, because they need
--  identical semantics: a script that behaves one way when pasted into the
--  editor and another when submitted from the desktop GUI is a bug nobody can
--  reproduce.
-- ============================================================================

-- GIVE THE CHUNK THE EXECUTOR'S ENVIRONMENT.
--
-- A loadstring()'d chunk otherwise runs against a VANILLA Roblox global table,
-- and `loadstring` does not exist there -- Roblox disables it, and the executor
-- injects its own into ITS environment only. Every real script starts with
--
--     loadstring(game:HttpGet("https://..."))()
--
-- so the very first call resolves to nil and the user gets "attempt to call a
-- nil value" with nothing whatsoever to act on. The chunk compiled fine; it
-- simply could not see the one function it needed.
--
-- Wrapped in pcall because setfenv/getfenv are deprecated in Luau and not every
-- build exposes them; failing to set the env must not stop the run.
local function adoptExecutorEnv(fn)
    pcall(function()
        local env
        if getgenv then env = getgenv() end
        if not env and getfenv then env = getfenv(1) end
        if env and setfenv then setfenv(fn, env) end
    end)
end

-- Say WHICH executor globals are absent. "attempt to call a nil value" names
-- nothing on its own, and this is the difference between a report we can act on
-- and another round of guessing.
local function missingGlobals()
    local miss = ""
    pcall(function()
        local want = {"loadstring", "getgenv", "gethui", "setfenv",
                      "request", "setclipboard", "isfile", "writefile"}
        local gone = {}
        for _, k in ipairs(want) do
            local have = rawget(getfenv(1), k) ~= nil
            if not have and getgenv then have = getgenv()[k] ~= nil end
            if not have then gone[#gone + 1] = k end
        end
        if #gone > 0 then miss = "  [missing: " .. table.concat(gone, ", ") .. "]" end
    end)
    return miss
end

-- Compile and run `source`. Returns (ok, output) and never raises.
function OMNI.runLuau(source)
    if type(source) ~= "string" or source:match("^%s*$") then
        return false, "nothing to run"
    end

    local fn, compileError = loadstring(source)
    if not fn then
        return false, "compile error: " .. tostring(compileError)
    end
    adoptExecutorEnv(fn)

    local ok, ret = xpcall(fn, function(e)
        local traceback = ""
        pcall(function()
            if debug and debug.traceback then
                traceback = "\n" .. tostring(debug.traceback("", 2))
            end
        end)
        return tostring(e) .. traceback
    end)

    if ok then
        return true, (ret ~= nil and tostring(ret) or "ok")
    end
    return false, "runtime error: " .. tostring(ret) .. missingGlobals()
end

-- Clipboard, through whichever name this executor happens to provide.
function OMNI.setClipboard(text)
    local fn = setclipboard or toclipboard or set_clipboard
    if not fn then return false end
    return pcall(fn, text)
end
