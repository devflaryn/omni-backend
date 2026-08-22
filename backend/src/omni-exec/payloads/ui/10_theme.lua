-- ============================================================================
--  Palette and instance helpers.
--
--  THE PANEL IS COLOURLESS ON PURPOSE. The intro sweep is the only place this
--  product spends hue; once it hands over, the menu is neutral greys — dark
--  but never black, and no accent tint anywhere. The only two coloured pixels
--  in the whole menu are the bridge-state dot and a failed run's output, and
--  both are carrying information rather than decorating.
--
--  The greys are Google's dark surfaces rather than an invented ramp, because
--  the whole point of a neutral palette is that it looks deliberate, and a
--  hand-mixed grey almost never does — it comes out tinted, and over a
--  saturated game the tint is what the eye picks up first. These are measured
--  values: #131314 background, #1E1F20 surface, #282A2C raised, #444746
--  outline, #E3E3E3 on-surface.
--
--  RADII ARE TOKENS, not literals at the call site. A modern Google surface is
--  identified as much by its corner radius as by its colour, and the two rules
--  that matter are that CONTAINERS are softly rounded and CONTROLS are fully
--  round. Spelling `999` into thirty call sites is how half of them end up as
--  `8` instead.
-- ============================================================================

OMNI.theme = {
    BG      = Color3.fromRGB(30, 31, 32),    -- window body (surface container)
    RAIL    = Color3.fromRGB(19, 19, 20),    -- icon rail, recessed
    SUNK    = Color3.fromRGB(19, 19, 20),    -- editor / output wells
    RAISED  = Color3.fromRGB(40, 42, 44),    -- buttons, fields
    RAISED2 = Color3.fromRGB(53, 55, 58),    -- hover / active
    PRESS   = Color3.fromRGB(63, 65, 68),    -- pressed state layer
    LINE    = Color3.fromRGB(68, 71, 70),    -- hairlines, outlines
    TXT     = Color3.fromRGB(227, 227, 227),
    MUTE    = Color3.fromRGB(196, 199, 197),
    DIM     = Color3.fromRGB(154, 160, 166),
    OK      = Color3.fromRGB(129, 201, 149),
    BAD     = Color3.fromRGB(242, 139, 130),
    WHITE   = Color3.fromRGB(255, 255, 255),
}

-- Containers are softly rounded, controls are fully round. See the header.
OMNI.radius = {
    panel   = 20,
    card    = 16,
    well    = 14,
    chip    = 12,
    control = 999,
}

OMNI.font = {
    body  = Enum.Font.Gotham,
    med   = Enum.Font.GothamMedium,
    bold  = Enum.Font.GothamBold,
    black = Enum.Font.GothamBlack,
    mono  = Enum.Font.Code,
}

-- ---------------------------------------------------------------------------
-- Instance construction. Parent is assigned LAST (after every other property)
-- because Roblox re-renders on each property write once an object is in the
-- tree, and this builds a few hundred of them on a guest with one vCPU.
function OMNI.mk(class, props, parent)
    local o = Instance.new(class)
    for k, v in pairs(props or {}) do
        o[k] = v
    end
    if parent then o.Parent = parent end
    return o
end

function OMNI.corner(o, r)
    return OMNI.mk("UICorner", {CornerRadius = UDim.new(0, r or OMNI.radius.card)}, o)
end

function OMNI.stroke(o, col, thickness, transparency)
    return OMNI.mk("UIStroke", {
        Color = col or OMNI.theme.LINE,
        Thickness = thickness or 1,
        Transparency = transparency or 0,
        ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
    }, o)
end

function OMNI.pad(o, n, opts)
    opts = opts or {}
    return OMNI.mk("UIPadding", {
        PaddingLeft   = UDim.new(0, opts.left   or n),
        PaddingRight  = UDim.new(0, opts.right  or n),
        PaddingTop    = UDim.new(0, opts.top    or n),
        PaddingBottom = UDim.new(0, opts.bottom or n),
    }, o)
end

function OMNI.tween(o, time, props, style, direction)
    local info = TweenInfo.new(
        time,
        style or Enum.EasingStyle.Quad,
        direction or Enum.EasingDirection.Out
    )
    local t = OMNI.TweenS:Create(o, info, props)
    t:Play()
    return t
end

-- ---------------------------------------------------------------------------
-- THE STATE LAYER.
--
-- Every interactive surface in this menu tints on hover and tints further on
-- press, and it is one helper rather than per-control code because that is the
-- only way the whole menu agrees on what "pressed" looks like.
--
-- `AutoButtonColor` is deliberately NOT used for this. Roblox's own version
-- multiplies the button's colour, which on a near-black surface is a change of
-- about four RGB steps — invisible. It also has no hover state on touch, where
-- most of this product's users are, so a tap gives no feedback at all until
-- something happens. An explicit tween to a named colour does both.
--
-- Returns a `setBase` so a control whose resting colour CHANGES (a selected
-- rail item, a toggled row) can update it without the next hover snapping the
-- surface back to the old one.
function OMNI.stateLayer(button, base, hover, press)
    local t = OMNI.theme
    base  = base  or t.RAISED
    hover = hover or t.RAISED2
    press = press or t.PRESS

    button.AutoButtonColor = false
    button.BackgroundColor3 = base

    local inside, down = false, false
    local function paint()
        local want = base
        if down then want = press elseif inside then want = hover end
        OMNI.tween(button, 0.12, {BackgroundColor3 = want})
    end

    button.MouseEnter:Connect(function() inside = true; paint() end)
    button.MouseLeave:Connect(function() inside, down = false, false; paint() end)
    button.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            down = true; paint()
        end
    end)
    button.InputEnded:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            down = false; paint()
        end
    end)

    return function(newBase, newHover, newPress)
        base = newBase or base
        hover = newHover or hover
        press = newPress or press
        paint()
    end
end

-- ---------------------------------------------------------------------------
-- Drag that still registers taps.
--
-- Carried over from the first UI unchanged in behaviour, because it is right:
-- a floating control on a touch screen has to be movable AND clickable, and
-- telling those apart needs the movement threshold below. `onTap` fires only
-- when the pointer never travelled more than 8 px, so a sloppy tap still opens
-- the menu and a deliberate drag never does.
function OMNI.dragTap(obj, handle, onTap, onRelease)
    handle = handle or obj
    local dragging, moved, startInput, startPos

    handle.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1
            or i.UserInputType == Enum.UserInputType.Touch then
            dragging, moved = true, false
            startInput, startPos = i, obj.Position
        end
    end)

    OMNI.UIS.InputChanged:Connect(function(i)
        if not dragging then return end
        if i.UserInputType ~= Enum.UserInputType.MouseMovement
            and i.UserInputType ~= Enum.UserInputType.Touch then return end
        local d = i.Position - startInput.Position
        if (math.abs(d.X) + math.abs(d.Y)) > 8 then moved = true end
        obj.Position = UDim2.new(
            startPos.X.Scale, startPos.X.Offset + d.X,
            startPos.Y.Scale, startPos.Y.Offset + d.Y
        )
    end)

    OMNI.UIS.InputEnded:Connect(function(i)
        if not dragging then return end
        if i.UserInputType ~= Enum.UserInputType.MouseButton1
            and i.UserInputType ~= Enum.UserInputType.Touch then return end
        dragging = false
        if not moved and onTap then
            onTap()
        elseif moved and onRelease then
            onRelease()
        end
    end)
end
