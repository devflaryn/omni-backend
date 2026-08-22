-- ============================================================================
--  REMOTE-EXECUTE BRIDGE.
--
--  The Omni Executor desktop GUI submits Luau to /omni/exec/submit keyed by
--  this account's username; we claim a session, poll for jobs, run them, and
--  report the result. NOTHING AUTO-RUNS -- a job only exists because the owner
--  clicked Execute in the app.
--
--  Moved out of custom_ui.lua rather than rewritten. The comments below are
--  load-bearing: each one records a failure that cost a debugging session, and
--  the shapes they describe are why this works at all.
-- ============================================================================

function OMNI.startBridge()
    task.spawn(function()
        local state = OMNI.state.bridge
        local HttpS = OMNI.HttpS
        local Players = OMNI.Players
        local httprequest = (syn and syn.request) or (http and http.request)
                            or http_request or request

        while not Players.LocalPlayer do task.wait(0.4) end
        local channel = tostring(Players.LocalPlayer.Name)
        state.channel = channel

        -- Declared BEFORE report() so report closes over this local. Declared
        -- after, `token` inside report would resolve as a global and always
        -- read nil -- the result post would then be rejected as
        -- unauthenticated.
        local token = nil

        local function report(id, ok, output)
            if not token then return end
            -- Prefer POST (the full 7 KB of output); fall back to a GET
            -- carrying a truncated result, because an executor without
            -- httprequest would otherwise run the script and silently report
            -- nothing back.
            if httprequest then
                local sent = pcall(function()
                    httprequest({
                        Url = OMNI.BASE .. "/omni/exec/result",
                        Method = "POST",
                        Headers = {["Content-Type"] = "application/json"},
                        Body = HttpS:JSONEncode({
                            t = token, id = id, ok = ok and true or false,
                            output = tostring(output):sub(1, 7000),
                        }),
                    })
                end)
                if sent then return end
            end
            pcall(function()
                game:HttpGet(OMNI.BASE .. "/omni/exec/report?t=" .. HttpS:UrlEncode(token)
                    .. "&id=" .. HttpS:UrlEncode(tostring(id))
                    .. "&ok=" .. (ok and "true" or "false")
                    .. "&output=" .. HttpS:UrlEncode(tostring(output):sub(1, 1500)), true)
            end)
        end

        -- The queue is not readable by channel name alone: claim a session
        -- token first.
        --
        -- Claims over game:HttpGet, NOT httprequest. HttpGet is the one HTTP
        -- call every executor provides; syn.request/http.request/request are
        -- optional, and this executor does not expose one. Gating the claim on
        -- httprequest left the poller spinning forever, so it never reached
        -- the polling code at all -- jobs queued, lastPollMsAgo null, and the
        -- GUI reporting "No live session" over a loaded game.
        local function claim()
            local ok, body = pcall(function()
                return game:HttpGet(OMNI.BASE .. "/omni/exec/claim?channel="
                                    .. HttpS:UrlEncode(channel), true)
            end)
            if not ok or type(body) ~= "string" then return false end
            local parsed
            pcall(function() parsed = HttpS:JSONDecode(body) end)
            if parsed and parsed.token then
                token = parsed.token
                state.claimed = true
                return true
            end
            return false
        end

        state.phase = "claiming"
        state.detail = "claiming session (" .. channel .. ")"
        while not token do
            if claim() then break end
            task.wait(3)                     -- the launch lease may not be up yet
        end

        state.phase = "ready"
        state.detail = "ready (" .. channel .. ")"

        while true do
            local ok, body = pcall(function()
                return game:HttpGet(OMNI.BASE .. "/omni/exec/poll?t="
                                    .. HttpS:UrlEncode(token), true)
            end)

            if ok then
                state.lastPollAt = os.clock()
                if state.phase == "error" then
                    state.phase, state.detail = "ready", "ready (" .. channel .. ")"
                end
            else
                -- token expired / server restarted
                state.phase = "error"
                state.detail = "poll failed — re-claiming"
                if claim() then
                    state.phase = "ready"
                    state.detail = "re-claimed (" .. channel .. ")"
                end
            end

            if ok and type(body) == "string" and #body > 2 then
                local job
                pcall(function() job = HttpS:JSONDecode(body) end)
                if job and type(job.script) == "string" and job.id then
                    state.phase = "running"
                    state.detail = "running " .. tostring(job.id)

                    local ranOk, output = OMNI.runLuau(job.script)

                    state.lastJob = {id = job.id, ok = ranOk,
                                     output = tostring(output), at = os.clock()}
                    state.phase = "ready"
                    state.detail = ranOk and ("last job ok (" .. tostring(job.id) .. ")")
                                          or ("last job failed (" .. tostring(job.id) .. ")")
                    report(job.id, ranOk, output)
                end
            end

            task.wait(1)
        end
    end)
end
