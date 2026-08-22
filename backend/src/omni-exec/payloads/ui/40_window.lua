-- ============================================================================
--  THE WINDOW: shell, left icon rail, tab switching.
--
--  BUILT LAZILY, on the first open. A farming instance that never opens the
--  menu never allocates a single one of these objects, and most of them never
--  will — the whole Omnidroid path is designed around the menu staying shut.
--
--  SIZED TO THE VIEWPORT, not to a constant. The old window was a fixed
--  500x392, and farming boots a 480x270 panel (lean.FARMING_DISPLAY), so on
--  the mode this product spends most of its time in, the window was simply
--  larger than the screen.
--
--  Pages REGISTER THEMSELVES from the files that follow this one (50_script,
--  60_toggles, 70_status) rather than being named here. That is what keeps
--  this file about the shell: adding a page never means editing the shell, and
--  the shell never has to know what a page contains.
--
--  THE RAIL FOLLOWS MATERIAL'S NAVIGATION RAIL, which is worth naming because
--  it replaced something that looked almost the same and read much worse. The
--  old active tab was a 2x16 bar floating in the gutter beside the icon: two
--  pixels wide, the same colour as the text, on a panel that may be rendered
--  at 480x270 and then scaled. What marks the active item now is the item
--  itself — a filled rounded tile behind the glyph. It survives any scale,
--  because it is 40 px of contrast rather than 2.
-- ============================================================================

OMNI.pages = {}

function OMNI.registerPage(entry)
    OMNI.pages[#OMNI.pages + 1] = entry
end

local RAIL_WIDE, RAIL_NARROW = 56, 46
local BAR_H = 46

function OMNI.windowIsOpen()
    return OMNI.window ~= nil and OMNI.window.open == true
end

local function windowSize()
    local view = OMNI.viewport()
    return math.min(560, math.max(280, view.X - 32)),
           math.min(420, math.max(200, view.Y - 32))
end

function OMNI.buildWindow()
    if OMNI.window then return OMNI.window end
    local t = OMNI.theme
    local W, H = windowSize()
    local rail = (W < 400) and RAIL_NARROW or RAIL_WIDE
    local tile = rail - 16

    local win = OMNI.mk("Frame", {
        Name = "Window",
        AnchorPoint = Vector2.new(0.5, 0.5),
        Position = UDim2.new(0.5, 0, 0.5, 0),
        Size = UDim2.new(0, W, 0, H),
        BackgroundColor3 = t.BG,
        BorderSizePixel = 0,
        Visible = false,
        ClipsDescendants = true,
        ZIndex = 4,
    }, OMNI.gui)
    OMNI.corner(win, OMNI.radius.panel)
    OMNI.stroke(win, t.LINE, 1, 0.35)

    -- title bar ------------------------------------------------------------
    -- No fill and no divider. A tinted strip across the top is a title BAR;
    -- a modern surface just has a heading on it, and the drag handle is the
    -- whole empty area rather than a coloured band the user has to find.
    local bar = OMNI.mk("Frame", {
        Size = UDim2.new(1, 0, 0, BAR_H),
        BackgroundTransparency = 1,
        ZIndex = 5,
    }, win)

    -- The live bridge state, at a glance. One of the only two coloured things
    -- in this menu, and it is colour because the state IS the message.
    local dot = OMNI.mk("Frame", {
        AnchorPoint = Vector2.new(0, 0.5),
        Position = UDim2.new(0, 18, 0.5, 0),
        Size = UDim2.new(0, 7, 0, 7),
        BackgroundColor3 = t.DIM,
        BorderSizePixel = 0,
        ZIndex = 6,
    }, bar)
    OMNI.corner(dot, OMNI.radius.control)

    OMNI.mk("TextLabel", {
        BackgroundTransparency = 1,
        Position = UDim2.new(0, 33, 0, 0),
        Size = UDim2.new(1, -80, 1, 0),
        Font = OMNI.font.med,
        Text = "Omni Executor",
        TextSize = 14,
        TextColor3 = t.TXT,
        TextXAlignment = Enum.TextXAlignment.Left,
        ZIndex = 6,
    }, bar)

    local close = OMNI.mk("TextButton", {
        AnchorPoint = Vector2.new(1, 0.5),
        Position = UDim2.new(1, -12, 0.5, 0),
        Size = UDim2.new(0, 30, 0, 30),
        AutoButtonColor = false,
        Font = OMNI.font.med,
        Text = "\u{2715}",
        TextSize = 13,
        TextColor3 = t.MUTE,
        ZIndex = 6,
    }, bar)
    OMNI.corner(close, OMNI.radius.control)
    OMNI.stateLayer(close, t.BG, t.RAISED, t.RAISED2)

    -- rail -------------------------------------------------------------------
    local railFrame = OMNI.mk("Frame", {
        Position = UDim2.new(0, 0, 0, BAR_H),
        Size = UDim2.new(0, rail, 1, -BAR_H),
        BackgroundTransparency = 1,
        ZIndex = 5,
    }, win)
    OMNI.mk("UIListLayout", {
        Padding = UDim.new(0, 8),
        SortOrder = Enum.SortOrder.LayoutOrder,
        HorizontalAlignment = Enum.HorizontalAlignment.Center,
    }, railFrame)
    OMNI.pad(railFrame, 0, {top = 4, bottom = 12, left = 0, right = 0})

    -- content ----------------------------------------------------------------
    local content = OMNI.mk("Frame", {
        Position = UDim2.new(0, rail, 0, BAR_H),
        Size = UDim2.new(1, -rail, 1, -BAR_H),
        BackgroundTransparency = 1,
        ZIndex = 5,
    }, win)

    local state = {frame = win, bar = bar, content = content, dot = dot,
                   open = false, tabs = {}, active = nil, W = W, H = H}
    OMNI.window = state

    local function select(key)
        for k, tab in pairs(state.tabs) do
            local on = (k == key)
            tab.page.Visible = on
            tab.button.TextColor3 = on and t.TXT or t.DIM
            -- The resting colour changes with selection, so the state layer
            -- has to be told: otherwise the next hover paints the tile back to
            -- whatever it was built with and the selection visually falls off.
            tab.setBase(on and t.RAISED2 or t.BG,
                        on and t.PRESS or t.RAISED)
            if on and tab.onShow then
                local ok, err = pcall(tab.onShow)
                if not ok then warn("[OMNI-EXEC] page " .. k .. ": " .. tostring(err)) end
            end
        end
        state.active = key
    end
    state.select = select

    for index, entry in ipairs(OMNI.pages) do
        local button = OMNI.mk("TextButton", {
            LayoutOrder = index,
            Size = UDim2.new(0, tile, 0, tile),
            AutoButtonColor = false,
            Font = OMNI.font.med,
            Text = entry.icon,
            TextSize = 15,
            TextColor3 = t.DIM,
            ZIndex = 6,
        }, railFrame)
        OMNI.corner(button, OMNI.radius.chip)
        local setBase = OMNI.stateLayer(button, t.BG, t.RAISED, t.RAISED2)

        local page = OMNI.mk("Frame", {
            Name = entry.key,
            Size = UDim2.new(1, 0, 1, 0),
            BackgroundTransparency = 1,
            Visible = false,
            ZIndex = 5,
        }, content)
        OMNI.pad(page, 14, {left = 12, right = 16, top = 6, bottom = 14})

        local built = entry.build and entry.build(page) or {}
        state.tabs[entry.key] = {button = button, page = page, setBase = setBase,
                                 onShow = built.onShow}
        button.MouseButton1Click:Connect(function() select(entry.key) end)
    end

    if OMNI.pages[1] then select(OMNI.pages[1].key) end

    -- The header dot, refreshed ONLY while the window is open. A farming
    -- instance builds this window at most once and usually never; a timer that
    -- kept running behind a closed window would be a cost per instance for a
    -- pixel nobody can see.
    task.spawn(function()
        while win.Parent do
            if state.open then
                local phase = OMNI.state.bridge.phase
                local live = (phase == "ready" or phase == "running")
                dot.BackgroundColor3 = live and t.OK
                    or (phase == "error" and t.BAD or t.DIM)
            end
            task.wait(1)
        end
    end)

    close.MouseButton1Click:Connect(function() OMNI.setWindowOpen(false) end)
    OMNI.dragTap(win, bar, nil)
    return state
end

-- The window opens and closes by height, from the title bar downwards, which
-- is what makes it read as unfolding rather than as popping into existence.
function OMNI.setWindowOpen(open)
    local state = OMNI.buildWindow()
    if state.open == open then return end
    state.open = open
    OMNI.syncToggleGlyph(open)

    if open then
        state.frame.Visible = true
        state.frame.Size = UDim2.new(0, state.W, 0, BAR_H)
        OMNI.tween(state.frame, 0.26, {Size = UDim2.new(0, state.W, 0, state.H)},
                   Enum.EasingStyle.Quint)
    else
        OMNI.tween(state.frame, 0.18, {Size = UDim2.new(0, state.W, 0, BAR_H)},
                   Enum.EasingStyle.Quad, Enum.EasingDirection.In)
        task.delay(0.2, function()
            if not state.open then state.frame.Visible = false end
        end)
    end
end

-- ---------------------------------------------------------------------------
-- Small shared widgets. Here rather than in each page because three pages
-- wanting the same row is three chances for them to drift apart.

function OMNI.sectionLabel(parent, text, order)
    return OMNI.mk("TextLabel", {
        LayoutOrder = order or 0,
        BackgroundTransparency = 1,
        Size = UDim2.new(1, 0, 0, 24),
        Font = OMNI.font.med,
        Text = text,
        TextSize = 11,
        TextColor3 = OMNI.theme.DIM,
        TextXAlignment = Enum.TextXAlignment.Left,
        TextYAlignment = Enum.TextYAlignment.Bottom,
        ZIndex = 6,
    }, parent)
end

-- A pill button. Fully round, because that is what a modern Google control is
-- and because a 36 px pill is a far easier touch target than the 30 px
-- rounded rectangle it replaced.
function OMNI.flatButton(parent, text, order, cb, opts)
    opts = opts or {}
    local t = OMNI.theme
    local b = OMNI.mk("TextButton", {
        LayoutOrder = order or 0,
        Size = UDim2.new(0, 0, 0, 36),
        AutomaticSize = Enum.AutomaticSize.X,
        AutoButtonColor = false,
        Font = OMNI.font.med,
        Text = text,
        TextSize = 12,
        TextColor3 = opts.primary and Color3.fromRGB(24, 25, 26) or t.TXT,
        ZIndex = 6,
    }, parent)
    OMNI.corner(b, OMNI.radius.control)
    OMNI.pad(b, 0, {left = 18, right = 18, top = 0, bottom = 0})
    -- The one filled control in the menu. Not an accent — it is the same
    -- neutral ramp inverted, which is how a Google surface marks the primary
    -- action without introducing a hue.
    if opts.primary then
        OMNI.stateLayer(b, t.TXT, t.MUTE, t.DIM)
    else
        OMNI.stateLayer(b, t.RAISED, t.RAISED2, t.PRESS)
    end
    if cb then b.MouseButton1Click:Connect(cb) end
    return b
end

-- A switch. Returns the row plus a setter, because several toggles have to be
-- forced off from outside (a respawn, a teardown) and reaching into the row to
-- do it from the caller is how the visual state and the real state diverge.
--
-- THE KNOB GROWS WHEN IT IS ON, which is Material's switch and not decoration:
-- on a 480x270 panel scaled down to a thumbnail, a knob that only MOVES is two
-- indistinguishable grey states. One that also changes size stays readable at
-- any scale, and so does the outline that appears only in the off state.
function OMNI.switchRow(parent, label, order, onChange)
    local t = OMNI.theme
    local row = OMNI.mk("Frame", {
        LayoutOrder = order or 0,
        Size = UDim2.new(1, 0, 0, 40),
        BackgroundTransparency = 1,
        ZIndex = 6,
    }, parent)

    OMNI.mk("TextLabel", {
        BackgroundTransparency = 1,
        Size = UDim2.new(1, -64, 1, 0),
        Font = OMNI.font.body,
        Text = label,
        TextSize = 13,
        TextColor3 = t.TXT,
        TextXAlignment = Enum.TextXAlignment.Left,
        ZIndex = 6,
    }, row)

    local track = OMNI.mk("TextButton", {
        AnchorPoint = Vector2.new(1, 0.5),
        Position = UDim2.new(1, 0, 0.5, 0),
        Size = UDim2.new(0, 46, 0, 26),
        BackgroundColor3 = t.RAISED,
        AutoButtonColor = false,
        Text = "",
        ZIndex = 6,
    }, row)
    OMNI.corner(track, OMNI.radius.control)
    local edge = OMNI.stroke(track, t.LINE, 1, 0)

    local knob = OMNI.mk("Frame", {
        AnchorPoint = Vector2.new(0.5, 0.5),
        Position = UDim2.new(0, 13, 0.5, 0),
        Size = UDim2.new(0, 14, 0, 14),
        BackgroundColor3 = t.DIM,
        BorderSizePixel = 0,
        ZIndex = 7,
    }, track)
    OMNI.corner(knob, OMNI.radius.control)

    local on = false
    local function paint()
        OMNI.tween(knob, 0.16, {
            Position = on and UDim2.new(1, -13, 0.5, 0) or UDim2.new(0, 13, 0.5, 0),
            Size = on and UDim2.new(0, 20, 0, 20) or UDim2.new(0, 14, 0, 14),
            BackgroundColor3 = on and Color3.fromRGB(24, 25, 26) or t.DIM,
        }, Enum.EasingStyle.Back)
        OMNI.tween(track, 0.16, {BackgroundColor3 = on and t.TXT or t.RAISED})
        edge.Transparency = on and 1 or 0
    end

    local function set(v, silent)
        v = v and true or false
        if v == on then return end
        on = v
        paint()
        if not silent and onChange then
            local ok, err = pcall(onChange, on)
            if not ok then warn("[OMNI-EXEC] toggle " .. label .. ": " .. tostring(err)) end
        end
    end

    track.MouseButton1Click:Connect(function() set(not on) end)
    return row, set, function() return on end
end

-- A labelled slider. `fmt` renders the live value into the row's right-hand
-- readout; without it a number-less track is a guess.
function OMNI.sliderRow(parent, label, order, min, max, initial, onChange, fmt)
    local t = OMNI.theme
    local row = OMNI.mk("Frame", {
        LayoutOrder = order or 0,
        Size = UDim2.new(1, 0, 0, 44),
        BackgroundTransparency = 1,
        ZIndex = 6,
    }, parent)

    OMNI.mk("TextLabel", {
        BackgroundTransparency = 1,
        Size = UDim2.new(1, -64, 0, 16),
        Font = OMNI.font.body,
        Text = label,
        TextSize = 12,
        TextColor3 = t.DIM,
        TextXAlignment = Enum.TextXAlignment.Left,
        ZIndex = 6,
    }, row)

    local readout = OMNI.mk("TextLabel", {
        AnchorPoint = Vector2.new(1, 0),
        Position = UDim2.new(1, 0, 0, 0),
        Size = UDim2.new(0, 60, 0, 16),
        BackgroundTransparency = 1,
        Font = OMNI.font.mono,
        Text = "",
        TextSize = 12,
        TextColor3 = t.TXT,
        TextXAlignment = Enum.TextXAlignment.Right,
        ZIndex = 6,
    }, row)

    -- The hit target is the full 22 px strip; the 4 px track is only what is
    -- drawn on it. Dragging a 4 px line with a thumb is not possible.
    local hit = OMNI.mk("TextButton", {
        Position = UDim2.new(0, 0, 0, 22),
        Size = UDim2.new(1, 0, 0, 22),
        BackgroundTransparency = 1,
        AutoButtonColor = false,
        Text = "",
        ZIndex = 6,
    }, row)

    local track = OMNI.mk("Frame", {
        AnchorPoint = Vector2.new(0, 0.5),
        Position = UDim2.new(0, 0, 0.5, 0),
        Size = UDim2.new(1, 0, 0, 4),
        BackgroundColor3 = t.RAISED,
        BorderSizePixel = 0,
        ZIndex = 6,
    }, hit)
    OMNI.corner(track, OMNI.radius.control)

    local fill = OMNI.mk("Frame", {
        Size = UDim2.new(0, 0, 1, 0),
        BackgroundColor3 = t.TXT,
        BorderSizePixel = 0,
        ZIndex = 7,
    }, track)
    OMNI.corner(fill, OMNI.radius.control)

    local handle = OMNI.mk("Frame", {
        AnchorPoint = Vector2.new(0.5, 0.5),
        Position = UDim2.new(0, 0, 0.5, 0),
        Size = UDim2.new(0, 14, 0, 14),
        BackgroundColor3 = t.TXT,
        BorderSizePixel = 0,
        ZIndex = 8,
    }, hit)
    OMNI.corner(handle, OMNI.radius.control)

    local value = initial
    local function apply(v, silent)
        value = math.clamp(v, min, max)
        local alpha = (max > min) and ((value - min) / (max - min)) or 0
        fill.Size = UDim2.new(alpha, 0, 1, 0)
        handle.Position = UDim2.new(alpha, 0, 0.5, 0)
        readout.Text = fmt and fmt(value) or tostring(math.floor(value + 0.5))
        if not silent and onChange then
            local ok, err = pcall(onChange, value)
            if not ok then warn("[OMNI-EXEC] slider " .. label .. ": " .. tostring(err)) end
        end
    end

    local function fromX(x)
        local left = track.AbsolutePosition.X
        local width = math.max(1, track.AbsoluteSize.X)
        return min + ((max - min) * math.clamp((x - left) / width, 0, 1))
    end

    local dragging = false
    hit.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            OMNI.tween(handle, 0.1, {Size = UDim2.new(0, 18, 0, 18)})
            apply(fromX(i.Position.X))
        end
    end)
    OMNI.UIS.InputChanged:Connect(function(i)
        if not dragging then return end
        if i.UserInputType == Enum.UserInputType.MouseMovement
            or i.UserInputType == Enum.UserInputType.Touch then
            apply(fromX(i.Position.X))
        end
    end)
    OMNI.UIS.InputEnded:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            if dragging then
                OMNI.tween(handle, 0.12, {Size = UDim2.new(0, 14, 0, 14)})
            end
            dragging = false
        end
    end)

    apply(initial, true)
    return row, apply, function() return value end
end
