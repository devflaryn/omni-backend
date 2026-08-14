-- ============================================================================
--  OMNI-EXEC — a completely custom UI, served from the LOCAL SERVER.
--  This REPLACES the entire Arceus X menu (the executor runs this instead of the
--  real gist). Brand-new open/close button + brand-new window. No Arceus code.
-- ============================================================================
-- satisfy the executor's watchdogs (they spin waiting on these) since we replaced
-- the whole menu and never load the real init.lua
pcall(function() getgenv().initLoaded = true end)
pcall(function() getgenv().arceus = getgenv().arceus or {} end)
pcall(function() getgenv().ax = getgenv().arceus end)

local ok, err = pcall(function()
    local UIS     = game:GetService("UserInputService")
    local CoreGui = game:GetService("CoreGui")
    local TweenS  = game:GetService("TweenService")

    -- parent to a protected container if the executor offers one, else CoreGui
    local parent = CoreGui
    pcall(function() if gethui then parent = gethui() end end)
    local old = parent:FindFirstChild("OmniExecUI"); if old then old:Destroy() end

    -- theme
    local BG      = Color3.fromRGB(16, 16, 24)
    local BG2     = Color3.fromRGB(26, 26, 38)
    local ACCENT  = Color3.fromRGB(190, 40, 255)   -- purple
    local ACCENT2 = Color3.fromRGB(70, 200, 255)   -- cyan
    local TXT     = Color3.fromRGB(238, 238, 245)
    local MUTE    = Color3.fromRGB(150, 150, 170)

    local function corner(o, r) local c = Instance.new("UICorner"); c.CornerRadius = UDim.new(0, r or 10); c.Parent = o; return c end
    local function stroke(o, col, th, tr) local s = Instance.new("UIStroke"); s.Color = col; s.Thickness = th or 1; s.Transparency = tr or 0; s.Parent = o; return s end
    local function pad(o, n) local p = Instance.new("UIPadding"); p.PaddingLeft=UDim.new(0,n); p.PaddingRight=UDim.new(0,n); p.PaddingTop=UDim.new(0,n); p.PaddingBottom=UDim.new(0,n); p.Parent=o; return p end

    local gui = Instance.new("ScreenGui")
    gui.Name = "OmniExecUI"; gui.ResetOnSpawn = false; gui.IgnoreGuiInset = true
    gui.ZIndexBehavior = Enum.ZIndexBehavior.Global; gui.DisplayOrder = 1000000
    gui.Parent = parent

    -- ---- window ------------------------------------------------------------
    local win = Instance.new("Frame")
    win.Name = "Window"; win.AnchorPoint = Vector2.new(0.5, 0.5)
    win.Position = UDim2.new(0.5, 0, 0.5, 0); win.Size = UDim2.new(0, 500, 0, 392)
    win.BackgroundColor3 = BG; win.BorderSizePixel = 0; win.Visible = false; win.Parent = gui
    corner(win, 16); stroke(win, ACCENT, 2, 0.15)
    local grad = Instance.new("UIGradient", win)
    grad.Color = ColorSequence.new({ColorSequenceKeypoint.new(0, BG), ColorSequenceKeypoint.new(1, Color3.fromRGB(24,18,32))})
    grad.Rotation = 90

    -- title bar
    local bar = Instance.new("Frame"); bar.Size = UDim2.new(1,0,0,50); bar.BackgroundColor3 = BG2; bar.BorderSizePixel=0; bar.Parent = win
    corner(bar, 16)
    local barfix = Instance.new("Frame"); barfix.BackgroundColor3=BG2; barfix.BorderSizePixel=0; barfix.Size=UDim2.new(1,0,0,18); barfix.Position=UDim2.new(0,0,1,-18); barfix.Parent=bar
    local accentBar = Instance.new("Frame"); accentBar.Size=UDim2.new(0,4,1,-16); accentBar.Position=UDim2.new(0,10,0,8); accentBar.BorderSizePixel=0; accentBar.BackgroundColor3=ACCENT; accentBar.Parent=bar; corner(accentBar,2)
    local title = Instance.new("TextLabel"); title.BackgroundTransparency=1; title.Position=UDim2.new(0,24,0,0); title.Size=UDim2.new(1,-120,1,0)
    title.Font=Enum.Font.GothamBold; title.TextSize=19; title.TextXAlignment=Enum.TextXAlignment.Left; title.TextColor3=TXT
    title.Text="⚡ OMNI-EXEC"; title.Parent=bar
    local sub = Instance.new("TextLabel"); sub.BackgroundTransparency=1; sub.Position=UDim2.new(0,24,0,0); sub.Size=UDim2.new(1,-120,1,0)
    sub.Font=Enum.Font.Gotham; sub.TextSize=12; sub.TextXAlignment=Enum.TextXAlignment.Left; sub.TextYAlignment=Enum.TextYAlignment.Bottom; sub.TextColor3=ACCENT2
    sub.Text="   custom UI • served from local server"; sub.Parent=bar

    local closeBtn = Instance.new("TextButton"); closeBtn.Size=UDim2.new(0,34,0,34); closeBtn.Position=UDim2.new(1,-44,0.5,-17)
    closeBtn.BackgroundColor3=Color3.fromRGB(225,60,80); closeBtn.Text="✕"; closeBtn.Font=Enum.Font.GothamBold; closeBtn.TextSize=17; closeBtn.TextColor3=Color3.new(1,1,1); closeBtn.AutoButtonColor=true; closeBtn.Parent=bar
    corner(closeBtn, 9)

    -- body
    local body = Instance.new("Frame"); body.BackgroundTransparency=1; body.Position=UDim2.new(0,0,0,50); body.Size=UDim2.new(1,0,1,-50); body.Parent=win
    pad(body, 16)
    local list = Instance.new("UIListLayout", body); list.Padding=UDim.new(0,10); list.SortOrder=Enum.SortOrder.LayoutOrder

    local hero = Instance.new("TextLabel"); hero.BackgroundTransparency=1; hero.Size=UDim2.new(1,0,0,54); hero.LayoutOrder=1
    hero.Font=Enum.Font.Gotham; hero.TextSize=14; hero.TextWrapped=true; hero.TextColor3=TXT; hero.TextXAlignment=Enum.TextXAlignment.Left; hero.TextYAlignment=Enum.TextYAlignment.Top
    hero.Text="This entire window is a fresh custom UI streamed from your local server — the original Arceus menu was replaced end-to-end (new open/close button, new window)."
    hero.Parent=body

    local function button(text, order, cb)
        local b=Instance.new("TextButton"); b.Size=UDim2.new(1,0,0,42); b.LayoutOrder=order; b.BackgroundColor3=BG2; b.Text=text
        b.Font=Enum.Font.GothamMedium; b.TextSize=15; b.TextColor3=TXT; b.AutoButtonColor=true; b.Parent=body
        corner(b,10); stroke(b, ACCENT, 1, 0.45)
        b.MouseButton1Click:Connect(cb); return b
    end

    local status = Instance.new("TextLabel"); status.BackgroundTransparency=1; status.Size=UDim2.new(1,0,0,22); status.LayoutOrder=99
    status.Font=Enum.Font.Gotham; status.TextSize=13; status.TextColor3=ACCENT2; status.TextXAlignment=Enum.TextXAlignment.Left
    status.Text="● loaded — OMNI-EXEC custom UI is live"; status.Parent=body

    local n=0
    button("★  Test button (counter)", 2, function() n=n+1; status.Text="● test button clicked "..n.." time(s)" end)
    button("⧉  Run executor call (setclipboard)", 3, function() local okc=pcall(function() (setclipboard or toclipboard or function() end)("OMNI-EXEC on top") end); status.Text = okc and "● executor call ran ✓" or "● executor call failed" end)
    button("⚡  Execute Zap Hub  (luarmor GameId loader)", 4, function()
        local gid = game.GameId
        status.Text = "● Zap Hub: GameId "..tostring(gid).." — loading…"
        task.spawn(function()
            local loaders = {
                [3317771874] = "https://api.luarmor.net/files/v4/loaders/fafe8ae462077de187f9be4ae79ec921.lua",
                [6401952734] = "https://api.luarmor.net/files/v4/loaders/407302b689818327f1c68cb1ac93aa12.lua",
                [7436755782] = "https://api.luarmor.net/files/v4/loaders/c9e6f321d828a1011868ea975479556a.lua",
                [9363735110] = "https://api.luarmor.net/files/v4/loaders/aea435a66896a8755c172d046c8bcc67.lua",
            }
            local url = loaders[gid]
            if not url then
                status.Text = "● Zap Hub: GameId "..tostring(gid).." is not in the loader list"
                return
            end
            local okz, errz = pcall(function() loadstring(game:HttpGet(url))() end)
            status.Text = okz and ("● Zap Hub loaded ✓ (GameId "..tostring(gid)..")")
                                or ("● Zap Hub error: "..tostring(errz):sub(1,42))
        end)
    end)

    -- ---- open / close toggle button ---------------------------------------
    local toggle = Instance.new("TextButton")
    toggle.Name="Toggle"; toggle.Size=UDim2.new(0,66,0,66); toggle.Position=UDim2.new(0,26,0.5,-33)
    toggle.BackgroundColor3=ACCENT; toggle.Text="OE"; toggle.Font=Enum.Font.GothamBlack; toggle.TextSize=24; toggle.TextColor3=Color3.new(1,1,1); toggle.AutoButtonColor=false; toggle.Parent=gui
    corner(toggle, 999); stroke(toggle, Color3.new(1,1,1), 2, 0.25)
    local tg=Instance.new("UIGradient", toggle); tg.Color=ColorSequence.new(ACCENT, ACCENT2); tg.Rotation=45

    local isOpen=false
    local function setOpen(v)
        isOpen=v
        toggle.Text = v and "✕" or "OE"
        if v then
            win.Visible=true
            win.Size=UDim2.new(0,500,0,0)
            TweenS:Create(win, TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {Size=UDim2.new(0,500,0,392)}):Play()
        else
            TweenS:Create(win, TweenInfo.new(0.16), {Size=UDim2.new(0,500,0,0)}):Play()
            task.delay(0.17, function() if not isOpen then win.Visible=false end end)
        end
    end
    closeBtn.MouseButton1Click:Connect(function() setOpen(false) end)

    -- draggable that still registers taps (mobile-friendly)
    local function dragTap(obj, handle, onTap)
        handle = handle or obj
        local dragging, moved, startInput, startPos
        handle.InputBegan:Connect(function(i)
            if i.UserInputType==Enum.UserInputType.MouseButton1 or i.UserInputType==Enum.UserInputType.Touch then
                dragging=true; moved=false; startInput=i; startPos=obj.Position
            end
        end)
        UIS.InputChanged:Connect(function(i)
            if dragging and (i.UserInputType==Enum.UserInputType.MouseMovement or i.UserInputType==Enum.UserInputType.Touch) then
                local d=i.Position-startInput.Position
                if (math.abs(d.X)+math.abs(d.Y))>8 then moved=true end
                obj.Position=UDim2.new(startPos.X.Scale, startPos.X.Offset+d.X, startPos.Y.Scale, startPos.Y.Offset+d.Y)
            end
        end)
        UIS.InputEnded:Connect(function(i)
            if dragging and (i.UserInputType==Enum.UserInputType.MouseButton1 or i.UserInputType==Enum.UserInputType.Touch) then
                dragging=false
                if not moved and onTap then onTap() end
            end
        end)
    end
    dragTap(toggle, toggle, function() setOpen(not isOpen) end)
    dragTap(win, bar, nil)

    -- ===== remote execute bridge: poll our server for scripts to run (MANUAL only) =====
    -- The Omni Executor GUI submits Luau to /omni/exec/submit keyed by this account's
    -- username; we poll, loadstring() it, and report the result. Nothing auto-runs.
    task.spawn(function()
        local OMNI_BASE   = "__OMNI_BASE__"                    -- injected by the server
        local HttpService = game:GetService("HttpService")
        local Players     = game:GetService("Players")
        local httprequest = (syn and syn.request) or (http and http.request) or http_request or request
        while not Players.LocalPlayer do task.wait(0.4) end
        local channel = tostring(Players.LocalPlayer.Name)     -- = omnidroid account name
        -- Declared BEFORE report() so report closes over this local. Declared
        -- after, `OMNI_TOKEN` inside report would resolve as a global and always
        -- read nil — the result post would then be rejected as unauthenticated.
        local OMNI_TOKEN = nil
        local function report(id, okr, output)
            if not OMNI_TOKEN then return end
            -- Prefer POST (full 7 KB of output); fall back to a GET carrying a
            -- truncated result, because an executor without httprequest would
            -- otherwise run the script and silently report nothing back.
            if httprequest then
                local sent = pcall(function()
                    httprequest({
                        Url = OMNI_BASE.."/omni/exec/result",
                        Method = "POST",
                        Headers = {["Content-Type"]="application/json"},
                        Body = HttpService:JSONEncode({t=OMNI_TOKEN, id=id, ok=okr and true or false, output=tostring(output):sub(1,7000)}),
                    })
                end)
                if sent then return end
            end
            pcall(function()
                game:HttpGet(OMNI_BASE.."/omni/exec/report?t="..HttpService:UrlEncode(OMNI_TOKEN)
                             .."&id="..HttpService:UrlEncode(tostring(id))
                             .."&ok="..(okr and "true" or "false")
                             .."&output="..HttpService:UrlEncode(tostring(output):sub(1,1500)), true)
            end)
        end

        -- The queue is no longer readable by channel name alone: claim a session
        -- token first. The server only issues one while this account's OWNER has
        -- a live launch registered for it, which is what stops a stranger who
        -- knows the username from draining (or feeding) this session.
        -- Claims over game:HttpGet, NOT httprequest. HttpGet is the one HTTP
        -- call every executor provides; syn.request/http.request/request are
        -- optional, and this executor does not expose one. Gating the claim on
        -- httprequest left the poller spinning in the loop below forever, so it
        -- never reached the polling code at all — jobs queued, lastPollMsAgo
        -- null, and the GUI reporting "No live session" over a loaded game.
        local function claim()
            local okc, body = pcall(function()
                return game:HttpGet(OMNI_BASE.."/omni/exec/claim?channel="
                                    ..HttpService:UrlEncode(channel), true)
            end)
            if not okc or type(body) ~= "string" then return false end
            local parsed; pcall(function() parsed = HttpService:JSONDecode(body) end)
            if parsed and parsed.token then OMNI_TOKEN = parsed.token; return true end
            return false
        end

        status.Text = "● exec bridge: claiming session ("..channel..")"
        while not OMNI_TOKEN do
            if claim() then break end
            task.wait(3)                                        -- the launch lease may not be up yet
        end
        status.Text = "● exec bridge ready ("..channel..")"
        while true do
            local gok, body = pcall(function()
                return game:HttpGet(OMNI_BASE.."/omni/exec/poll?t="..HttpService:UrlEncode(OMNI_TOKEN), true)
            end)
            if not gok then                                     -- token expired / server restarted
                if claim() then status.Text = "● exec bridge re-claimed ("..channel..")" end
            end
            if gok and type(body)=="string" and #body > 2 then
                local job; pcall(function() job = HttpService:JSONDecode(body) end)
                if job and type(job.script)=="string" and job.id then
                    status.Text = "● exec: running "..tostring(job.id).."…"
                    local fn, cerr = loadstring(job.script)
                    if not fn then
                        report(job.id, false, "compile error: "..tostring(cerr))
                        status.Text = "● exec: compile error"
                    else
                        local rok, rret = pcall(fn)
                        local out = rok and (rret ~= nil and tostring(rret) or "ok") or ("runtime error: "..tostring(rret))
                        report(job.id, rok, out)
                        status.Text = rok and ("● exec ✓ "..tostring(job.id)) or ("● exec error: "..tostring(rret):sub(1,36))
                    end
                end
            end
            task.wait(1)
        end
    end)
end)
if not ok then warn("[OMNI-EXEC UI] error: "..tostring(err)) end
