-- ============================================================================
--  TOGGLES page — player and utility switches.
--
--  TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE, because they are what separate
--  a toggle from a one-way button:
--
--   1. EVERY FEATURE UNDOES ITSELF. Turning noclip off restores the collisions
--      it cleared -- only the ones it cleared -- and turning fly off removes
--      the force it added. A switch that cannot be switched back is a trap, and
--      "restart the game to undo it" is not an answer on a farming instance.
--
--   2. EVERY FEATURE SURVIVES A RESPAWN. A new character is a NEW Humanoid, so
--      WalkSpeed and JumpPower are back at their defaults and the noclip loop
--      is writing to parts that no longer exist -- while the switches still
--      read as ON. That divergence is the single most common bug in this class
--      of UI, so re-application is wired once, here, for all of them.
-- ============================================================================

OMNI.feat = {
    speed   = {on = false, value = 16},
    jump    = {on = false, value = 50},
    noclip  = {on = false},
    fly     = {on = false, value = 60},
    antiafk = {on = false},
}

local DEFAULT_SPEED, DEFAULT_JUMP = 16, 50

local function character()
    local lp = OMNI.Players.LocalPlayer
    return lp and lp.Character or nil
end

local function humanoid()
    local c = character()
    return c and c:FindFirstChildOfClass("Humanoid") or nil
end

local function rootPart()
    local c = character()
    return c and c:FindFirstChild("HumanoidRootPart") or nil
end

-- ---------------------------------------------------------------------------
-- Speed / jump: pure Humanoid properties, so "apply" and "revert" are the same
-- call with a different number.

local function applySpeed()
    local h = humanoid()
    if not h then return end
    h.WalkSpeed = OMNI.feat.speed.on and OMNI.feat.speed.value or DEFAULT_SPEED
end

local function applyJump()
    local h = humanoid()
    if not h then return end
    -- UseJumpPower must be set explicitly: on a character configured for
    -- JumpHeight instead, writing JumpPower is silently ignored.
    pcall(function() h.UseJumpPower = true end)
    h.JumpPower = OMNI.feat.jump.on and OMNI.feat.jump.value or DEFAULT_JUMP
end

-- ---------------------------------------------------------------------------
-- Noclip. Only parts this loop actually cleared are restored, which is why the
-- cleared set is tracked rather than blanket-setting CanCollide = true on the
-- way out: accessory handles and several rig parts are non-colliding by design,
-- and "restoring" those would change the character rather than put it back.

local noclipConnection, noclipCleared = nil, {}

local function noclipStop()
    if noclipConnection then
        noclipConnection:Disconnect()
        noclipConnection = nil
    end
    for part in pairs(noclipCleared) do
        if part and part.Parent then part.CanCollide = true end
    end
    noclipCleared = {}
end

local function noclipStart()
    noclipStop()
    noclipConnection = OMNI.RunS.Stepped:Connect(function()
        local c = character()
        if not c then return end
        for _, d in ipairs(c:GetDescendants()) do
            if d:IsA("BasePart") and d.CanCollide then
                d.CanCollide = false
                noclipCleared[d] = true
            end
        end
    end)
end

-- ---------------------------------------------------------------------------
-- Fly.
--
-- Steered off Humanoid.MoveDirection rather than off WASD, and that is the
-- whole reason it works here: MoveDirection is whatever the platform's own
-- controls produced, so the same code flies from a mobile thumbstick, from a
-- keyboard and from a gamepad. A KeyCode-driven fly is unusable on the device
-- this product mostly runs on.
--
-- Vertical comes from the CAMERA'S PITCH: MoveDirection is horizontal-only, so
-- pushing forward while looking up climbs. Plus Humanoid.Jump for straight up,
-- which is the on-screen jump button on touch and Space on desktop.

local flyConnection, flyForce = nil, nil

local function flyStop()
    if flyConnection then
        flyConnection:Disconnect()
        flyConnection = nil
    end
    if flyForce then
        flyForce:Destroy()
        flyForce = nil
    end
end

local function flyStart()
    flyStop()
    local root = rootPart()
    if not root then return end

    flyForce = OMNI.mk("BodyVelocity", {
        Name = "OmniFly",
        MaxForce = Vector3.new(1, 1, 1) * 1e5,
        Velocity = Vector3.new(0, 0, 0),
    }, root)

    flyConnection = OMNI.RunS.RenderStepped:Connect(function()
        if not flyForce or not flyForce.Parent then return end
        local h, cam = humanoid(), workspace.CurrentCamera
        if not h or not cam then return end

        local move = h.MoveDirection
        local look, right = cam.CFrame.LookVector, cam.CFrame.RightVector
        local flatLook = Vector3.new(look.X, 0, look.Z)
        local flatRight = Vector3.new(right.X, 0, right.Z)
        flatLook = (flatLook.Magnitude > 0) and flatLook.Unit or Vector3.new(0, 0, 0)
        flatRight = (flatRight.Magnitude > 0) and flatRight.Unit or Vector3.new(0, 0, 0)

        local direction = (look * move:Dot(flatLook)) + (right * move:Dot(flatRight))
        if h.Jump then direction = direction + Vector3.new(0, 1, 0) end
        if direction.Magnitude > 0 then direction = direction.Unit end

        flyForce.Velocity = direction * OMNI.feat.fly.value
    end)
end

-- ---------------------------------------------------------------------------
-- Anti-AFK. Roblox disconnects an idle client after ~20 minutes, which on a
-- farming instance means the instance quietly stops earning.

local idledConnection = nil

local function antiAfkStop()
    if idledConnection then
        idledConnection:Disconnect()
        idledConnection = nil
    end
end

local function antiAfkStart()
    antiAfkStop()
    local lp = OMNI.Players.LocalPlayer
    if not lp then return end
    idledConnection = lp.Idled:Connect(function()
        pcall(function()
            local vu = game:GetService("VirtualUser")
            vu:CaptureController()
            vu:ClickButton2(Vector2.new())
        end)
    end)
end

-- ---------------------------------------------------------------------------
-- Re-application. Wired ONCE, whatever the page does afterwards, because a
-- respawn does not care whether the menu happens to be open.

-- ONLY WHAT IS SWITCHED ON, and that restriction is the whole point rather
-- than an optimisation.
--
-- A fresh character already has the game's own WalkSpeed and JumpPower. Calling
-- applySpeed() unconditionally would write DEFAULT_SPEED over it on every
-- respawn, in every instance, whether or not the user ever touched the switch —
-- so a place that starts its players at 24 would silently be dragged back to 16
-- by a menu nobody opened. The revert belongs at the moment the switch is
-- turned OFF, which is where applySpeed() is called from; a respawn is not a
-- revert, it is a character this UI has no opinion about yet.
OMNI.reapplyFeatures = function()
    if OMNI.feat.speed.on then applySpeed() end
    if OMNI.feat.jump.on then applyJump() end
    if OMNI.feat.noclip.on then noclipStart() end
    if OMNI.feat.fly.on then flyStart() end
end

local function anyFeatureOn()
    for _, feature in pairs(OMNI.feat) do
        if feature.on then return true end
    end
    return false
end

do
    local lp = OMNI.Players.LocalPlayer
    if lp then
        lp.CharacterAdded:Connect(function()
            -- Nothing is on, so there is nothing this UI owns on the new
            -- character. Costs a farming instance exactly one table walk per
            -- respawn, which is the case it is in for its entire life.
            if not anyFeatureOn() then return end
            -- Wait for the Humanoid rather than assuming it: CharacterAdded
            -- fires before the rig is fully populated, and writing WalkSpeed to
            -- a character that has no Humanoid yet does nothing at all.
            task.delay(0.6, function()
                local ok, err = pcall(OMNI.reapplyFeatures)
                if not ok then warn("[OMNI-EXEC] reapply: " .. tostring(err)) end
            end)
        end)
    end
end

-- ---------------------------------------------------------------------------

OMNI.registerPage({
    key = "toggles",
    icon = "\u{2699}",
    build = function(page)
        -- A ScrollingFrame because five rows do not fit a 480x270 farming
        -- panel, and the page must not silently clip the last switch.
        local list = OMNI.mk("ScrollingFrame", {
            Size = UDim2.new(1, 0, 1, 0),
            BackgroundTransparency = 1,
            BorderSizePixel = 0,
            CanvasSize = UDim2.new(0, 0, 0, 0),
            AutomaticCanvasSize = Enum.AutomaticSize.Y,
            ScrollBarThickness = 3,
            ScrollBarImageColor3 = OMNI.theme.LINE,
            ZIndex = 6,
        }, page)
        OMNI.mk("UIListLayout", {
            Padding = UDim.new(0, 4),
            SortOrder = Enum.SortOrder.LayoutOrder,
        }, list)
        OMNI.pad(list, 0, {left = 0, right = 8, top = 0, bottom = 8})

        OMNI.sectionLabel(list, "Movement", 1)

        OMNI.switchRow(list, "Walk speed", 2, function(on)
            OMNI.feat.speed.on = on
            applySpeed()
        end)
        OMNI.sliderRow(list, "Speed", 3, 16, 250, OMNI.feat.speed.value, function(v)
            OMNI.feat.speed.value = math.floor(v + 0.5)
            if OMNI.feat.speed.on then applySpeed() end
        end)

        OMNI.switchRow(list, "Jump power", 4, function(on)
            OMNI.feat.jump.on = on
            applyJump()
        end)
        OMNI.sliderRow(list, "Power", 5, 50, 350, OMNI.feat.jump.value, function(v)
            OMNI.feat.jump.value = math.floor(v + 0.5)
            if OMNI.feat.jump.on then applyJump() end
        end)

        OMNI.sectionLabel(list, "World", 6)

        OMNI.switchRow(list, "Noclip", 7, function(on)
            OMNI.feat.noclip.on = on
            if on then noclipStart() else noclipStop() end
        end)

        OMNI.switchRow(list, "Fly", 8, function(on)
            OMNI.feat.fly.on = on
            if on then flyStart() else flyStop() end
        end)
        OMNI.sliderRow(list, "Fly speed", 9, 20, 300, OMNI.feat.fly.value, function(v)
            OMNI.feat.fly.value = math.floor(v + 0.5)
        end)

        OMNI.sectionLabel(list, "Session", 10)

        OMNI.switchRow(list, "Anti-AFK", 11, function(on)
            OMNI.feat.antiafk.on = on
            if on then antiAfkStart() else antiAfkStop() end
        end)

        return {}
    end,
})
