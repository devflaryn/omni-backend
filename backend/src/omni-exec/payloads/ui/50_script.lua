-- ============================================================================
--  SCRIPT page — the editor.
--
--  Laid out FROM THE BOTTOM: the output pane and the button row are pinned to
--  the bottom edge and the editor takes whatever is left. That is what lets the
--  same page work on a 480x270 farming panel and on a phone, without a second
--  layout: the parts with a fixed useful height keep it, and the one part that
--  is better when bigger absorbs the difference.
--
--  The bottom-anchored offsets below are a CHAIN, not four independent
--  numbers: output is 44 tall at the bottom edge, the button row is 36 tall
--  starting 54 up from it, and the editor ends 10 px above the row. Change one
--  and the next one has to move, which is why they are derived here rather
--  than typed in four places.
-- ============================================================================

OMNI.registerPage({
    key = "script",
    icon = "{ }",
    build = function(page)
        local t = OMNI.theme

        local OUT_H, ROW_H, GAP = 44, 36, 10
        local ROW_Y = OUT_H + GAP                  -- row bottom, above output
        local EDITOR_BOTTOM = ROW_Y + ROW_H + GAP  -- editor bottom, above row
        local EDITOR_TOP = 22

        OMNI.mk("TextLabel", {
            BackgroundTransparency = 1,
            Size = UDim2.new(1, 0, 0, 16),
            Font = OMNI.font.med,
            Text = "Script",
            TextSize = 11,
            TextColor3 = t.DIM,
            TextXAlignment = Enum.TextXAlignment.Left,
            ZIndex = 6,
        }, page)

        local editorFrame = OMNI.mk("Frame", {
            Position = UDim2.new(0, 0, 0, EDITOR_TOP),
            Size = UDim2.new(1, 0, 1, -(EDITOR_TOP + EDITOR_BOTTOM)),
            BackgroundColor3 = t.SUNK,
            BorderSizePixel = 0,
            ClipsDescendants = true,
            ZIndex = 6,
        }, page)
        OMNI.corner(editorFrame, OMNI.radius.well)
        OMNI.stroke(editorFrame, t.LINE, 1, 0.5)
        OMNI.pad(editorFrame, 12)

        -- ClearTextOnFocus is FALSE and that is not a style choice: the default
        -- wipes the box the moment it is tapped, so on a touch device every
        -- attempt to edit an existing script destroys it first.
        local editor = OMNI.mk("TextBox", {
            BackgroundTransparency = 1,
            Size = UDim2.new(1, 0, 1, 0),
            Font = OMNI.font.mono,
            Text = "",
            PlaceholderText = "-- paste or type Luau here",
            PlaceholderColor3 = t.DIM,
            TextSize = 12,
            TextColor3 = t.TXT,
            TextXAlignment = Enum.TextXAlignment.Left,
            TextYAlignment = Enum.TextYAlignment.Top,
            TextWrapped = true,
            MultiLine = true,
            ClearTextOnFocus = false,
            ZIndex = 6,
        }, editorFrame)

        local output = OMNI.mk("TextLabel", {
            AnchorPoint = Vector2.new(0, 1),
            Position = UDim2.new(0, 0, 1, 0),
            Size = UDim2.new(1, 0, 0, OUT_H),
            BackgroundColor3 = t.SUNK,
            BorderSizePixel = 0,
            Font = OMNI.font.mono,
            Text = "ready",
            TextSize = 11,
            TextColor3 = t.MUTE,
            TextXAlignment = Enum.TextXAlignment.Left,
            TextYAlignment = Enum.TextYAlignment.Top,
            TextWrapped = true,
            ZIndex = 6,
        }, page)
        OMNI.corner(output, OMNI.radius.well)
        OMNI.pad(output, 10)

        local row = OMNI.mk("Frame", {
            AnchorPoint = Vector2.new(0, 1),
            Position = UDim2.new(0, 0, 1, -ROW_Y),
            Size = UDim2.new(1, 0, 0, ROW_H),
            BackgroundTransparency = 1,
            ZIndex = 6,
        }, page)
        OMNI.mk("UIListLayout", {
            FillDirection = Enum.FillDirection.Horizontal,
            Padding = UDim.new(0, 8),
            SortOrder = Enum.SortOrder.LayoutOrder,
        }, row)

        local function report(ok, text)
            output.TextColor3 = ok and t.MUTE or t.BAD
            output.Text = tostring(text)
        end

        -- Execute is the FILLED button and the other two are not. One primary
        -- action per surface is the whole convention; three identical grey
        -- pills is a row in which nothing is the answer.
        OMNI.flatButton(row, "Execute", 1, function()
            report(true, "running…")
            -- Deferred so the "running…" frame actually reaches the screen
            -- before a synchronous script blocks the thread. Without it a slow
            -- script looks like a dead button.
            task.defer(function()
                local ok, out = OMNI.runLuau(editor.Text)
                report(ok, out)
            end)
        end, {primary = true})

        OMNI.flatButton(row, "Clear", 2, function()
            editor.Text = ""
            report(true, "ready")
        end)

        OMNI.flatButton(row, "Copy", 3, function()
            local ok = OMNI.setClipboard(editor.Text)
            report(ok, ok and "copied to clipboard"
                          or "this executor exposes no clipboard function")
        end)

        return {}
    end,
})
