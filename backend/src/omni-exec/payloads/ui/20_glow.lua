-- ============================================================================
--  THE INTRO GLOW.
--
--  A soft ambient wash bleeds in from every screen edge and sweeps once
--  through ORANGE -> GREEN -> BLUE, the way Google animates a product launch,
--  then destroys itself. Strongest at the bottom and top, near-invisible
--  through the middle, with a fine field of four-pointed sparkles over it.
--
--  BUILT ENTIRELY FROM PRIMITIVES, because there is no asset pipeline here:
--  four Frames, one UIGradient each. That constraint decides the rest of the
--  implementation, because of one Roblox fact:
--
--      NumberSequence and ColorSequence are NOT TWEENABLE.
--
--  So the falloff ramp (a NumberSequence) is set ONCE — it is the shape, not
--  the animation — and the animation is carried by each frame's own
--  BackgroundTransparency, which composes with the ramp. The hue is likewise
--  not tweenable, so a single NumberValue is tweened 0 -> 1 and all four
--  gradients recolour off its Changed signal: one driver, four followers, and
--  no RenderStepped loop anywhere in the file.
--
--  THE SWEEP IS DIRECTED, NOT A LOOP, and that is the difference between this
--  and a rainbow. A looping palette walk has no beginning and no end: it
--  arrives on whatever hue the clock happened to land on and wraps back
--  through every colour in between. The reference reads as ONE GESTURE because
--  it TRAVELS — it starts warm, passes through green, settles on blue, and it
--  never comes back. So `sampleGlow` CLAMPS instead of wrapping, and each edge
--  carries a LAG rather than a phase offset: every panel walks the same
--  orange -> green -> blue path, later panels simply set off later. Mid
--  animation the bottom already reads blue while the top is still green, which
--  is the frame the reference is recognisable by; at rest all four agree.
--
--  COST IS BOUNDED DELIBERATELY. This payload runs inside every farming
--  instance, so the sparkle field is skipped outright on Omnidroid: nobody is
--  watching those frames, and 60 extra TextLabels x 30 instances is real work
--  spent on an audience of nobody. Everything here is Destroy()ed when the
--  envelope closes; the steady-state cost of the intro is zero.
-- ============================================================================

-- Google's three, softened. Full-chroma #EA8600 / #34A853 / #4285F4 laid over
-- a live game reads as an error state rather than as a brand; these sit about
-- a third of the way to white, which is where the reference sits.
OMNI.GLOW_STOPS = {
    Color3.fromRGB(247, 168, 88),    -- orange
    Color3.fromRGB(104, 195, 132),   -- green
    Color3.fromRGB(108, 156, 242),   -- blue
}

OMNI.GLOW_IN, OMNI.GLOW_HOLD, OMNI.GLOW_OUT = 0.60, 1.30, 0.85

-- Zero on Omnidroid. See the header.
OMNI.SPARKLE_COUNT = 60

-- The falloff. Invisible at the screen's centre, visible at its edge, with the
-- knee near the outside so the wash stays soft rather than reading as a band.
OMNI.GLOW_RAMP = NumberSequence.new({
    NumberSequenceKeypoint.new(0.00, 1.00),
    NumberSequenceKeypoint.new(0.45, 0.94),
    NumberSequenceKeypoint.new(0.78, 0.58),
    NumberSequenceKeypoint.new(1.00, 0.14),
})

-- Gradient Rotation is chosen per edge so that gradient offset 1 always lands
-- ON the screen edge and offset 0 points inward. That lets all four panels
-- share one ramp: 0 = left->right, 90 = top->bottom, 180 = right->left,
-- 270 = bottom->top.
--
-- `lag` is how far into the sweep this edge sets off. Bottom leads because it
-- is the strongest panel and the eye goes there first.
OMNI.GLOW_EDGES = {
    {name = "Bottom", size = UDim2.new(1, 0, 0.46, 0), pos = UDim2.new(0, 0, 1, 0),
     anchor = Vector2.new(0, 1), rot = 90,  gain = 1.00, lag = 0.00},
    {name = "Top",    size = UDim2.new(1, 0, 0.42, 0), pos = UDim2.new(0, 0, 0, 0),
     anchor = Vector2.new(0, 0), rot = 270, gain = 0.90, lag = 0.30},
    {name = "Left",   size = UDim2.new(0.30, 0, 1, 0), pos = UDim2.new(0, 0, 0, 0),
     anchor = Vector2.new(0, 0), rot = 180, gain = 0.58, lag = 0.15},
    {name = "Right",  size = UDim2.new(0.30, 0, 1, 0), pos = UDim2.new(1, 0, 0, 0),
     anchor = Vector2.new(1, 0), rot = 0,   gain = 0.58, lag = 0.45},
}

-- Walk the palette ONCE, end to end. t <= 0 is the first stop and t >= 1 is
-- the last: clamped, never wrapped, so the sweep has a start and a finish.
function OMNI.sampleGlow(t)
    local stops = OMNI.GLOW_STOPS
    local n = #stops
    if n == 1 then return stops[1] end
    t = math.clamp(t, 0, 1)
    local scaled = t * (n - 1)
    local i = math.min(math.floor(scaled), n - 2)
    return stops[i + 1]:Lerp(stops[i + 2], scaled - i)
end

-- Map the driver's 0..1 onto this edge's own 0..1, so an edge that sets off
-- late still ARRIVES: without the rescale a lagged panel would stop short of
-- blue and the four edges would settle on four different colours.
local function edgeAlpha(t, lag)
    if lag <= 0 then return t end
    return math.clamp((t - lag) / (1 - lag), 0, 1)
end

local function buildSparkles(root, count)
    local sparkles = {}
    for i = 1, count do
        -- Biased towards the top and bottom thirds: the sparkle field belongs
        -- where the wash is, and a uniform scatter puts most of it in the pale
        -- middle where it reads as dirt on the screen rather than as texture.
        local y = (math.random() < 0.5)
            and (math.random() * 0.30)
            or  (0.66 + math.random() * 0.34)
        local label = OMNI.mk("TextLabel", {
            BackgroundTransparency = 1,
            Size = UDim2.new(0, 18, 0, 18),
            Position = UDim2.new(math.random(), 0, y, 0),
            Rotation = math.random(-30, 30),
            Font = OMNI.font.bold,
            Text = "\u{2726}",
            TextSize = math.random(7, 15),
            TextTransparency = 1,
            TextColor3 = OMNI.sampleGlow(math.random()),
            ZIndex = 3,
        }, root)
        sparkles[#sparkles + 1] = {
            label = label,
            peak = 0.30 + math.random() * 0.40,
            delay = math.random() * 0.55,
        }
    end
    return sparkles
end

-- Play the intro, then call `onDone` exactly once. `onDone` runs whether or not
-- anything in here worked: the entry affordance is how a user reaches the
-- product, and an animation is never allowed to be the reason it never appears.
function OMNI.playGlow(onDone)
    local fired = false
    local function finish()
        if fired then return end
        fired = true
        if onDone then
            local ok, err = pcall(onDone)
            if not ok then warn("[OMNI-EXEC] entry failed: " .. tostring(err)) end
        end
    end

    local ok, err = pcall(function()
        local root = OMNI.mk("Frame", {
            Name = "Glow",
            BackgroundTransparency = 1,
            Size = UDim2.new(1, 0, 1, 0),
            Active = false,             -- must never eat input from the game
            ZIndex = 2,
        }, OMNI.gui)

        local panels = {}
        for _, edge in ipairs(OMNI.GLOW_EDGES) do
            local frame = OMNI.mk("Frame", {
                Name = edge.name,
                AnchorPoint = edge.anchor,
                Position = edge.pos,
                Size = edge.size,
                BackgroundColor3 = OMNI.theme.WHITE,
                BackgroundTransparency = 1,
                BorderSizePixel = 0,
                Active = false,
                ZIndex = 2,
            }, root)
            local gradient = OMNI.mk("UIGradient", {
                Rotation = edge.rot,
                Transparency = OMNI.GLOW_RAMP,
            }, frame)
            panels[#panels + 1] = {
                frame = frame,
                gradient = gradient,
                lag = edge.lag,
                -- Target transparency for the fade-in. Composed with the ramp
                -- this lands the very edge near 0.42 alpha, which is where the
                -- reference sits: present, never opaque.
                target = 1 - (0.60 * edge.gain),
            }
        end

        local sparkles = {}
        if not OMNI.isOmnidroid and OMNI.SPARKLE_COUNT > 0 then
            sparkles = buildSparkles(root, OMNI.SPARKLE_COUNT)
        end

        -- The single driver. Linear, because the hue should travel at a
        -- constant rate while the envelope does the easing.
        local total = OMNI.GLOW_IN + OMNI.GLOW_HOLD + OMNI.GLOW_OUT
        local driver = OMNI.mk("NumberValue", {Value = 0}, root)
        driver:GetPropertyChangedSignal("Value"):Connect(function()
            local t = driver.Value
            for _, p in ipairs(panels) do
                local a = edgeAlpha(t, p.lag)
                -- The second stop TRAILS the first along the same path, which
                -- gives each panel an internal gradient while the sweep is
                -- moving and none at all once it has arrived.
                p.gradient.Color = ColorSequence.new(
                    OMNI.sampleGlow(a),
                    OMNI.sampleGlow(a - 0.14)
                )
            end
        end)
        OMNI.tween(driver, total, {Value = 1.0},
                   Enum.EasingStyle.Linear, Enum.EasingDirection.InOut)

        for _, p in ipairs(panels) do
            OMNI.tween(p.frame, OMNI.GLOW_IN, {BackgroundTransparency = p.target})
        end
        for _, s in ipairs(sparkles) do
            task.delay(s.delay, function()
                if not s.label.Parent then return end
                OMNI.tween(s.label, 0.45, {TextTransparency = s.peak})
            end)
        end

        task.delay(OMNI.GLOW_IN + OMNI.GLOW_HOLD, function()
            for _, p in ipairs(panels) do
                if p.frame.Parent then
                    OMNI.tween(p.frame, OMNI.GLOW_OUT, {BackgroundTransparency = 1},
                               Enum.EasingStyle.Quad, Enum.EasingDirection.In)
                end
            end
            for _, s in ipairs(sparkles) do
                if s.label.Parent then
                    OMNI.tween(s.label, OMNI.GLOW_OUT * 0.8, {TextTransparency = 1})
                end
            end
        end)

        task.delay(total, function()
            if root.Parent then root:Destroy() end
            finish()
        end)
    end)

    if not ok then
        warn("[OMNI-EXEC] glow failed: " .. tostring(err))
        finish()
    end
end
