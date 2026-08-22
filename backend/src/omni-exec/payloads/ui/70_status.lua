-- ============================================================================
--  STATUS page — what this instance is actually doing.
--
--  Read-only, and it invents nothing: every field is read out of OMNI.state,
--  which the bridge writes as it goes. No new backend endpoints exist for this
--  page, and none are needed.
--
--  It ticks ONLY WHILE VISIBLE. A farming instance leaves this page built but
--  hidden for hours, and a timer redrawing labels nobody can see is exactly the
--  kind of cost that multiplies by thirty.
-- ============================================================================

OMNI.registerPage({
    key = "status",
    icon = "\u{25C9}",
    build = function(page)
        local t = OMNI.theme

        local list = OMNI.mk("ScrollingFrame", {
            Size = UDim2.new(1, 0, 1, 0),
            BackgroundTransparency = 1,
            BorderSizePixel = 0,
            CanvasSize = UDim2.new(0, 0, 0, 0),
            AutomaticCanvasSize = Enum.AutomaticSize.Y,
            ScrollBarThickness = 3,
            ScrollBarImageColor3 = t.LINE,
            ZIndex = 6,
        }, page)
        OMNI.mk("UIListLayout", {
            Padding = UDim.new(0, 2),
            SortOrder = Enum.SortOrder.LayoutOrder,
        }, list)
        OMNI.pad(list, 0, {left = 0, right = 8, top = 0, bottom = 8})

        local order = 0
        local function row(label)
            order = order + 1
            local holder = OMNI.mk("Frame", {
                LayoutOrder = order,
                Size = UDim2.new(1, 0, 0, 28),
                BackgroundTransparency = 1,
                ZIndex = 6,
            }, list)
            OMNI.mk("TextLabel", {
                BackgroundTransparency = 1,
                Size = UDim2.new(0.42, 0, 1, 0),
                Font = OMNI.font.body,
                Text = label,
                TextSize = 12,
                TextColor3 = t.DIM,
                TextXAlignment = Enum.TextXAlignment.Left,
                ZIndex = 6,
            }, holder)
            return OMNI.mk("TextLabel", {
                Position = UDim2.new(0.42, 0, 0, 0),
                Size = UDim2.new(0.58, 0, 1, 0),
                BackgroundTransparency = 1,
                Font = OMNI.font.mono,
                Text = "—",
                TextSize = 12,
                TextColor3 = t.TXT,
                TextXAlignment = Enum.TextXAlignment.Left,
                TextTruncate = Enum.TextTruncate.AtEnd,
                ZIndex = 6,
            }, holder)
        end

        -- The connection dot, and the second of the only two coloured things
        -- in this UI. Green/red is the state itself, not decoration.
        order = order + 1
        local head = OMNI.mk("Frame", {
            LayoutOrder = order,
            Size = UDim2.new(1, 0, 0, 30),
            BackgroundTransparency = 1,
            ZIndex = 6,
        }, list)
        local dot = OMNI.mk("Frame", {
            AnchorPoint = Vector2.new(0, 0.5),
            Position = UDim2.new(0, 1, 0.5, 0),
            Size = UDim2.new(0, 7, 0, 7),
            BackgroundColor3 = t.DIM,
            BorderSizePixel = 0,
            ZIndex = 6,
        }, head)
        OMNI.corner(dot, 999)
        local headText = OMNI.mk("TextLabel", {
            BackgroundTransparency = 1,
            Position = UDim2.new(0, 18, 0, 0),
            Size = UDim2.new(1, -18, 1, 0),
            Font = OMNI.font.med,
            Text = "starting",
            TextSize = 13,
            TextColor3 = t.TXT,
            TextXAlignment = Enum.TextXAlignment.Left,
            ZIndex = 6,
        }, head)

        local vAccount = row("account")
        local vHost    = row("host")
        local vBridge  = row("bridge")
        local vPoll    = row("last poll")
        local vUptime  = row("uptime")
        local vJob     = row("last job")
        local vPlace   = row("place")
        local vGame    = row("game id")

        local function refresh()
            local b = OMNI.state.bridge
            local lp = OMNI.Players.LocalPlayer

            local live = (b.phase == "ready" or b.phase == "running")
            dot.BackgroundColor3 = live and t.OK
                or (b.phase == "error" and t.BAD or t.DIM)
            headText.Text = live and "connected" or b.phase

            vAccount.Text = (lp and lp.Name) or "—"
            vHost.Text    = OMNI.hostDetail
                or (OMNI.isOmnidroid and "omnidroid" or "generic device")
            vBridge.Text  = b.detail ~= "" and b.detail or b.phase

            if b.lastPollAt then
                vPoll.Text = string.format("%.0fs ago", os.clock() - b.lastPollAt)
            else
                vPoll.Text = "never"
            end

            vUptime.Text = OMNI.uptimeText()

            if b.lastJob then
                vJob.Text = string.format("%s %s", b.lastJob.id,
                                          b.lastJob.ok and "ok" or "failed")
            else
                vJob.Text = "none"
            end

            vPlace.Text = tostring(game.PlaceId)
            vGame.Text  = tostring(game.GameId)
        end

        -- Ticks only while this page is on screen. Started once, and it parks
        -- on a cheap 1 s wait whenever the page is hidden rather than being
        -- torn down and rebuilt every time the user changes tab.
        task.spawn(function()
            while page.Parent do
                if page.Visible then
                    local ok, err = pcall(refresh)
                    if not ok then warn("[OMNI-EXEC] status: " .. tostring(err)) end
                end
                task.wait(1)
            end
        end)

        return {onShow = refresh}
    end,
})
