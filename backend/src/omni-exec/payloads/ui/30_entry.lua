-- ============================================================================
--  HOW THE USER REACHES THE MENU — and it is not the same everywhere.
--
--  Generic Android device / emulator:
--      the sweep ends and a floating button fades in. It stays. That is
--      somebody's phone: a visible, permanent way in is the correct answer,
--      and no message is shown, because there is nothing to announce — the
--      person holding the device already knows what they installed.
--
--  Omnidroid:
--      the sweep ends and a card slides down from the top centre saying
--      Omnidroid connected. It goes away by itself. NO FLOATING BUTTON IS
--      LEFT ON SCREEN, because an unattended farming instance with a control
--      parked over the game is the one shape this product must never ship.
--
--      Tapping the card PROMOTES the button — from then on this session
--      behaves like a generic device, because the user has now said they want
--      the UI.
--
--  WHAT REPLACED THE INVISIBLE STRIP, and why. The way back in after the card
--  left used to be a hover/tap zone over the top 8% of the screen with nothing
--  drawn in it. It worked, and it was undiscoverable: a control whose entire
--  affordance is that you already know it is there is not a control. It is now
--  a HANDLE — a 40x4 hairline bar centred on the very top edge, the shape a
--  phone uses for a pull-down. Reaching it slides the same pill down.
--
--  That handle is 160 pixels of dim grey at the top edge of a farming guest,
--  against a floating 56 px button over the middle of the game. The rule the
--  design set — leave the client clean — is about not obscuring the game and
--  not appearing in a capture as a control someone could press; a hairline on
--  the bezel edge does neither, and it is the difference between the menu
--  being reachable and being folklore.
-- ============================================================================

OMNI.POPUP_HOLD = 5.5      -- seconds before the connected card leaves by itself
OMNI.SWIPE_DISMISS_PX = 20 -- upward travel that dismisses it immediately

-- ---------------------------------------------------------------------------
-- The floating button.
--
-- A ROUNDED SQUARE, not a circle, and 16 px of radius is the reason it reads
-- as current rather than as 2016. Google moved its floating action button off
-- the circle years ago; a 56 px circle with a glyph in it is the shape every
-- other Roblox executor still ships, which is exactly why this one should not.

OMNI.TOGGLE_SIZE = 56
OMNI.TOGGLE_MARGIN = 16

function OMNI.showToggle(opts)
    opts = opts or {}
    if OMNI.toggle then return OMNI.toggle end
    OMNI.state.toggleShown = true

    local t = OMNI.theme
    local view = OMNI.viewport()

    -- RIGHT EDGE, ABOVE CENTRE. The old position was the left edge at exactly
    -- half height, which on a phone is on top of the movement thumbstick — the
    -- one place on a Roblox screen guaranteed to be under a thumb. The right
    -- side at 38% clears the stick, and it clears the jump button too.
    local btn = OMNI.mk("TextButton", {
        Name = "Toggle",
        AnchorPoint = Vector2.new(0, 0),
        Position = UDim2.new(0, math.max(OMNI.TOGGLE_MARGIN,
                                         view.X - OMNI.TOGGLE_SIZE - OMNI.TOGGLE_MARGIN),
                             0.38, 0),
        Size = UDim2.new(0, OMNI.TOGGLE_SIZE, 0, OMNI.TOGGLE_SIZE),
        AutoButtonColor = false,
        Text = "\u{2726}",
        Font = OMNI.font.med,
        TextSize = 22,
        TextColor3 = t.TXT,
        ZIndex = 6,
    }, OMNI.gui)
    OMNI.corner(btn, OMNI.radius.card)
    OMNI.stroke(btn, t.LINE, 1, 0.45)
    OMNI.stateLayer(btn, t.RAISED, t.RAISED2, t.PRESS)

    OMNI.toggle = btn

    -- Snap to whichever side is nearer once the drag ends. A control the user
    -- flung across the screen should come to rest against an edge rather than
    -- floating over the middle of the game.
    local function snap()
        local v = OMNI.viewport()
        local mid = btn.AbsolutePosition.X + (btn.AbsoluteSize.X / 2)
        local x = (mid < v.X / 2)
            and OMNI.TOGGLE_MARGIN
            or (v.X - OMNI.TOGGLE_SIZE - OMNI.TOGGLE_MARGIN)
        local y = math.clamp(btn.AbsolutePosition.Y, OMNI.TOGGLE_MARGIN,
                             math.max(OMNI.TOGGLE_MARGIN,
                                      v.Y - OMNI.TOGGLE_SIZE - OMNI.TOGGLE_MARGIN))
        OMNI.tween(btn, 0.22, {Position = UDim2.new(0, x, 0, y)},
                   Enum.EasingStyle.Back)
    end

    OMNI.dragTap(btn, btn, function()
        OMNI.setWindowOpen(not OMNI.windowIsOpen())
    end, snap)

    -- Enter by scaling up from nothing, so it reads as arriving rather than
    -- as having been there all along.
    if opts.instant then
        return btn
    end
    local pos = btn.Position
    btn.Size = UDim2.new(0, 0, 0, 0)
    btn.TextTransparency = 1
    btn.Position = UDim2.new(pos.X.Scale, pos.X.Offset + OMNI.TOGGLE_SIZE / 2,
                             pos.Y.Scale, pos.Y.Offset + OMNI.TOGGLE_SIZE / 2)
    OMNI.tween(btn, 0.30, {
        Size = UDim2.new(0, OMNI.TOGGLE_SIZE, 0, OMNI.TOGGLE_SIZE),
        Position = pos,
        TextTransparency = 0,
    }, Enum.EasingStyle.Back)
    return btn
end

-- Called when the glyph should reflect the window's state.
function OMNI.syncToggleGlyph(isOpen)
    if OMNI.toggle then
        OMNI.toggle.Text = isOpen and "\u{2715}" or "\u{2726}"
    end
end

-- ---------------------------------------------------------------------------
-- The user has asked for the UI. Give them the permanent way in and stop
-- offering the temporary ones.
function OMNI.promoteToggle()
    if OMNI.edgeReveal then
        OMNI.edgeReveal:Destroy()
        OMNI.edgeReveal = nil
    end
    OMNI.showToggle()
end

-- ---------------------------------------------------------------------------
-- The Omnidroid card.
--
-- Two lines, left-aligned, with a glyph tile — the shape of a Google system
-- notification rather than of a toast, because a toast is read and forgotten
-- and this one is asking to be pressed.

function OMNI.showConnectedPopup()
    local t = OMNI.theme
    local W, H = 292, 60
    local HIDDEN = UDim2.new(0.5, 0, 0, -(H + 24))
    local SHOWN  = UDim2.new(0.5, 0, 0, 16)

    local card = OMNI.mk("TextButton", {
        Name = "ConnectedPopup",
        AnchorPoint = Vector2.new(0.5, 0),
        Position = HIDDEN,
        Size = UDim2.new(0, W, 0, H),
        AutoButtonColor = false,
        Text = "",
        ZIndex = 7,
    }, OMNI.gui)
    OMNI.corner(card, OMNI.radius.card)
    OMNI.stroke(card, t.LINE, 1, 0.4)
    OMNI.stateLayer(card, t.BG, t.RAISED, t.RAISED2)

    local tile = OMNI.mk("TextLabel", {
        AnchorPoint = Vector2.new(0, 0.5),
        Position = UDim2.new(0, 12, 0.5, 0),
        Size = UDim2.new(0, 34, 0, 34),
        BackgroundColor3 = t.RAISED,
        Text = "\u{2726}",
        Font = OMNI.font.med,
        TextSize = 16,
        TextColor3 = t.TXT,
        ZIndex = 8,
    }, card)
    OMNI.corner(tile, OMNI.radius.chip)

    OMNI.mk("TextLabel", {
        BackgroundTransparency = 1,
        Position = UDim2.new(0, 56, 0, 11),
        Size = UDim2.new(1, -68, 0, 19),
        Font = OMNI.font.bold,
        Text = "Omnidroid connected",
        TextSize = 14,
        TextColor3 = t.TXT,
        TextXAlignment = Enum.TextXAlignment.Left,
        ZIndex = 8,
    }, card)

    OMNI.mk("TextLabel", {
        BackgroundTransparency = 1,
        Position = UDim2.new(0, 56, 0, 30),
        Size = UDim2.new(1, -68, 0, 18),
        Font = OMNI.font.body,
        Text = "Click here to view the screen",
        TextSize = 12,
        TextColor3 = t.DIM,
        TextXAlignment = Enum.TextXAlignment.Left,
        ZIndex = 8,
    }, card)

    -- The gesture listeners have to live on UserInputService (a drag that
    -- leaves the card still has to be tracked), so they outlive the card unless
    -- something disconnects them. Held here and dropped in dismiss(): this
    -- payload runs in thirty unattended instances, and two dead connections
    -- apiece re-entered on every input event is exactly the sort of cost that
    -- is invisible in one instance and measurable in thirty.
    local gestures = {}
    local gone = false

    local function dismiss(opened)
        if gone then return end
        gone = true
        for _, connection in ipairs(gestures) do connection:Disconnect() end
        gestures = {}
        OMNI.tween(card, 0.3, {Position = HIDDEN},
                   Enum.EasingStyle.Quad, Enum.EasingDirection.In)
        task.delay(0.32, function()
            if card.Parent then card:Destroy() end
            -- Only when the user let it go by itself does the client stay
            -- clean. If they engaged with it they have asked for the UI.
            if not opened then OMNI.installTopEdgeReveal() end
        end)
    end

    -- Swipe up to get rid of it now. Tracked here rather than through dragTap
    -- because this control does not move — only the gesture's direction
    -- matters, and a downward drag should do nothing at all.
    local startY, tracking = nil, false
    card.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            tracking, startY = true, i.Position.Y
        end
    end)
    gestures[#gestures + 1] = OMNI.UIS.InputChanged:Connect(function(i)
        if not tracking or gone then return end
        if i.UserInputType ~= Enum.UserInputType.MouseMovement
            and i.UserInputType ~= Enum.UserInputType.Touch then return end
        if (i.Position.Y - startY) < -OMNI.SWIPE_DISMISS_PX then
            tracking = false
            dismiss(false)
        end
    end)
    gestures[#gestures + 1] = OMNI.UIS.InputEnded:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            tracking = false
        end
    end)

    card.MouseButton1Click:Connect(function()
        if gone then return end
        dismiss(true)
        OMNI.promoteToggle()
        OMNI.setWindowOpen(true)
    end)

    OMNI.tween(card, 0.42, {Position = SHOWN}, Enum.EasingStyle.Quint)
    task.delay(OMNI.POPUP_HOLD, function() dismiss(false) end)
    return card
end

-- ---------------------------------------------------------------------------
-- The top-edge handle: the way back in once the card has gone.
--
-- Listens for HOVER AND TOUCH, and that is not belt-and-braces. Whether this
-- guest presents a pointer at all depends on the QEMU input device it was
-- booted with (farming boots `usb: True`, so it may), and a reveal that
-- understood only one of the two would be simply unreachable on the other —
-- which on the Omnidroid path means the menu has no entry point whatsoever.
--
-- The hit zone is deliberately much larger than the mark that advertises it:
-- 8% of the screen height against a 4 px bar. Aiming at a hairline on a touch
-- screen is not a thing anyone can do.
function OMNI.installTopEdgeReveal()
    if OMNI.edgeReveal or OMNI.state.toggleShown then return end
    local t = OMNI.theme

    local zone = OMNI.mk("TextButton", {
        Name = "EdgeReveal",
        BackgroundTransparency = 1,
        Text = "",
        AutoButtonColor = false,
        Position = UDim2.new(0, 0, 0, 0),
        Size = UDim2.new(1, 0, 0.08, 0),
        ZIndex = 6,
    }, OMNI.gui)
    OMNI.edgeReveal = zone

    -- The only thing left on screen on a farming instance.
    local handle = OMNI.mk("Frame", {
        Name = "Handle",
        AnchorPoint = Vector2.new(0.5, 0),
        Position = UDim2.new(0.5, 0, 0, 3),
        Size = UDim2.new(0, 40, 0, 4),
        BackgroundColor3 = t.DIM,
        BackgroundTransparency = 0.45,
        BorderSizePixel = 0,
        ZIndex = 7,
    }, zone)
    OMNI.corner(handle, OMNI.radius.control)

    local pill = OMNI.mk("TextButton", {
        Name = "ShowUI",
        AnchorPoint = Vector2.new(0.5, 0),
        Position = UDim2.new(0.5, 0, 0, -38),
        Size = UDim2.new(0, 118, 0, 34),
        AutoButtonColor = false,
        Font = OMNI.font.med,
        Text = "Show UI",
        TextSize = 12,
        TextColor3 = t.TXT,
        ZIndex = 8,
    }, zone)
    OMNI.corner(pill, OMNI.radius.control)
    OMNI.stroke(pill, t.LINE, 1, 0.4)
    OMNI.stateLayer(pill, t.BG, t.RAISED, t.RAISED2)

    local shown, retractAt = false, nil
    local function show()
        retractAt = nil
        if shown then return end
        shown = true
        OMNI.tween(pill, 0.24, {Position = UDim2.new(0.5, 0, 0, 12)},
                   Enum.EasingStyle.Quint)
        OMNI.tween(handle, 0.18, {BackgroundTransparency = 1})
    end
    local function scheduleRetract()
        retractAt = os.clock() + 2.5
    end

    zone.MouseEnter:Connect(show)
    zone.MouseLeave:Connect(scheduleRetract)
    zone.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.Touch
            or i.UserInputType == Enum.UserInputType.MouseButton1 then
            show()
            scheduleRetract()
        end
    end)

    pill.MouseButton1Click:Connect(function()
        OMNI.promoteToggle()
        OMNI.setWindowOpen(true)
    end)

    -- One coroutine on a 0.25 s tick rather than a RenderStepped connection.
    -- It exits for good the moment the zone is gone, which promoteToggle does.
    task.spawn(function()
        while zone.Parent do
            if shown and retractAt and os.clock() >= retractAt then
                shown, retractAt = false, nil
                OMNI.tween(pill, 0.2, {Position = UDim2.new(0.5, 0, 0, -38)},
                           Enum.EasingStyle.Quad, Enum.EasingDirection.In)
                OMNI.tween(handle, 0.3, {BackgroundTransparency = 0.45})
            end
            task.wait(0.25)
        end
    end)

    return zone
end
