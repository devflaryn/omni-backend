-- ============================================================================
--  THE SEQUENCE.
--
--      bridge starts (in parallel, it has its own wait-for-LocalPlayer)
--      glow plays  ->  generic device : the floating toggle appears
--                      omnidroid      : the connected pill drops in and leaves
--
--  The bridge is kicked off FIRST and does not wait for the animation. Its
--  claim loop can sit for seconds against a launch lease that is not up yet,
--  and spending the glow's two seconds on that instead of after it is free.
-- ============================================================================

OMNI.startBridge()

-- Autoexec runs alongside the bridge: it has its own wait-for-LocalPlayer and
-- fetch, so it must not delay the glow or the bridge's claim loop.
OMNI.runAutoexec()

OMNI.playGlow(function()
    if OMNI.isOmnidroid then
        OMNI.showConnectedPopup()
    else
        OMNI.showToggle()
    end
end)
