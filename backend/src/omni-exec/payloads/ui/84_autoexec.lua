-- ============================================================================
--  AUTOEXEC.
--
--  The scripts the host dropped in its autoexec directory. The omnidroid engine
--  pushes them to /omni/exec/autoexec/set (keyed by this account's username)
--  once per launch; we fetch them here and run each ONCE at session start.
--
--  This is the executor's "autoexec folder", but delivered over game:HttpGet --
--  the one HTTP call every executor provides -- rather than through a workspace
--  file, because this build's isfile/readfile do not reliably see files the
--  host writes into the app's storage (the same reason the Omnidroid marker is
--  a best-effort detail, not a hard dependency). Fetch-and-run over HttpGet is
--  the channel the remote-execute bridge already proves works in every session.
--
--  Best-effort in every direction: no network, a bad JSON body, an empty list
--  or a script that errors must each cost only that one script, never the menu.
--  Each script runs through OMNI.runLuau (the same entry the bridge uses), so a
--  failure is caught and surfaced to the executor console rather than thrown.
-- ============================================================================

function OMNI.runAutoexec()
    task.spawn(function()
        local HttpS   = OMNI.HttpS
        local Players = OMNI.Players

        while not Players.LocalPlayer do task.wait(0.3) end
        local channel = tostring(Players.LocalPlayer.Name)

        local ok, body = pcall(function()
            return game:HttpGet(OMNI.BASE .. "/omni/exec/autoexec?channel="
                                .. HttpS:UrlEncode(channel), true)
        end)
        if not ok or type(body) ~= "string" then return end

        local data
        pcall(function() data = HttpS:JSONDecode(body) end)
        if not (data and type(data.scripts) == "table") then return end

        local n = #data.scripts
        if n == 0 then return end

        local function log(msg)
            pcall(function()
                if rconsoleprint then rconsoleprint("[OMNI-EXEC autoexec] " .. msg .. "\n") end
            end)
        end

        log("running " .. n .. " script" .. (n == 1 and "" or "s") .. " for " .. channel)
        for _, s in ipairs(data.scripts) do
            if type(s) == "table" and type(s.body) == "string" and s.body ~= "" then
                local name = tostring(s.name or "script")
                local ranOk, out = OMNI.runLuau(s.body)
                log(name .. (ranOk and " ok" or (" ERROR: " .. tostring(out))))
            end
        end
    end)
end
