(() => {
    "use strict";

    const CAPTURE_DURATION = 20_000;
    const START_POINT_DURATION = 5_000;
    const SAMPLE_INTERVAL = 100;
    const MANUAL_STOP_TAIL = 2_000;
    const OUTPUT_WIDTH = 3840;
    const OUTPUT_HEIGHT = 2160;
    const canvas = document.getElementById("artwork");
    const context = canvas.getContext("2d", { alpha: false });
    const app = document.querySelector(".app");
    const controls = document.querySelector(".controls");
    const traceNumber = document.getElementById("traceNumber");
    const dragHandle = document.getElementById("dragHandle");
    const minimizeButton = document.getElementById("minimizeButton");
    const startButton = document.getElementById("startButton");
    const stopButton = document.getElementById("stopButton");
    const stopButtonLabel = document.getElementById("stopButtonLabel");
    const stopButtonHint = document.getElementById("stopButtonHint");
    const primingCount = document.getElementById("primingCount");
    const stopButtonHome = stopButton.parentElement;
    const downloadButton = document.getElementById("downloadButton");
    const paletteButton = document.getElementById("paletteButton");
    const timer = document.getElementById("timer");
    const progressBar = document.getElementById("progressBar");
    const progressTrack = document.getElementById("progressTrack");
    const sessionPanel = document.getElementById("sessionPanel");
    const sessionState = document.getElementById("sessionState");
    const status = document.getElementById("status");
    const hueControl = document.getElementById("hueControl");
    const saturationControl = document.getElementById("saturationControl");
    const lightnessControl = document.getElementById("lightnessControl");
    const hueValue = document.getElementById("hueValue");
    const saturationValue = document.getElementById("saturationValue");
    const lightnessValue = document.getElementById("lightnessValue");

    if (!context) {
        status.textContent = "This browser could not create a 2D canvas context.";
        startButton.disabled = true;
        downloadButton.disabled = true;
        return;
    }

    canvas.width = OUTPUT_WIDTH;
    canvas.height = OUTPUT_HEIGHT;

    let trackingData = [];
    let renderedTrackingData = [];
    let capturing = false;
    let preparingCapture = false;
    let captureNumber = 1;
    let hasStartedCapture = false;
    let captureStartedAt = 0;
    let sampleTimer = null;
    let preparationTimer = null;
    let preparationStartedAt = 0;
    let latestPosition = { x: 0.5, y: 0.5 };
    // Split-complementary hues with a small analogous pair around the base.
    const PALETTE_HARMONY = [0, 15, 345, 150, 210];
    let palette = {
        hue: Math.floor(Math.random() * 360),
        saturation: 70,
        lightness: 0
    };
    let stopPlaceholder = null;
    let sessionPlaceholder = null;
    let stopReturnTimer = null;
    let dragPointerId = null;
    let dragOffset = { x: 0, y: 0 };

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const wrapHue = value => ((value % 360) + 360) % 360;
    const setStatus = message => { status.textContent = message; };

    function debounce(callback, delay) {
        let timeout = null;
        return (...args) => {
            window.clearTimeout(timeout);
            timeout = window.setTimeout(() => callback(...args), delay);
        };
    }

    function paletteHue(index, shift = 0) {
        return wrapHue(palette.hue + PALETTE_HARMONY[index % PALETTE_HARMONY.length] + shift);
    }

    function colorFor(hue, saturation, lightness, alpha) {
        return `hsla(${wrapHue(hue)}, ${clamp(saturation, 0, 100)}%, ${clamp(lightness, 0, 100)}%, ${alpha})`;
    }

    function updateSession(elapsed = 0) {
        const remaining = Math.max(0, CAPTURE_DURATION - elapsed);
        const seconds = Math.ceil(remaining / 1000);
        timer.value = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        timer.textContent = timer.value;
        const progress = clamp((elapsed / CAPTURE_DURATION) * 100, 0, 100);
        progressBar.style.width = `${progress}%`;
        progressTrack.setAttribute("aria-valuenow", String(Math.floor(Math.min(elapsed, CAPTURE_DURATION) / 1000)));
    }

    function updatePaletteControls() {
        hueControl.value = String(palette.hue);
        saturationControl.value = String(palette.saturation);
        lightnessControl.value = String(palette.lightness);
        updatePaletteReadout();
    }

    function updatePaletteReadout(values = palette) {
        hueValue.value = `${values.hue}°`;
        hueValue.textContent = hueValue.value;
        saturationValue.value = `${values.saturation}%`;
        saturationValue.textContent = saturationValue.value;
        lightnessValue.value = String(values.lightness);
        lightnessValue.textContent = lightnessValue.value;
    }

    function setControlsPosition(left, top) {
        const maxLeft = Math.max(0, window.innerWidth - controls.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - controls.offsetHeight);
        controls.style.left = `${clamp(left, 0, maxLeft)}px`;
        controls.style.top = `${clamp(top, 0, maxTop)}px`;
        controls.style.transform = "none";
    }

    function beginControlsDrag(event) {
        if (event.button !== 0 || capturing) return;
        const rect = controls.getBoundingClientRect();
        dragOffset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        dragPointerId = event.pointerId;
        setControlsPosition(rect.left, rect.top);
        dragHandle.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function moveControls(event) {
        if (event.pointerId !== dragPointerId) return;
        setControlsPosition(event.clientX - dragOffset.x, event.clientY - dragOffset.y);
    }

    function endControlsDrag(event) {
        if (event.pointerId !== dragPointerId) return;
        dragPointerId = null;
        if (dragHandle.hasPointerCapture(event.pointerId)) {
            dragHandle.releasePointerCapture(event.pointerId);
        }
    }

    function nudgeControls(event) {
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        const rect = controls.getBoundingClientRect();
        const step = event.shiftKey ? 30 : 10;
        const left = rect.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0);
        const top = rect.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0);
        setControlsPosition(left, top);
        event.preventDefault();
    }

    function recordPosition(time) {
        const previous = trackingData[trackingData.length - 1];
        const point = {
            x: clamp(latestPosition.x, 0, 1),
            y: clamp(latestPosition.y, 0, 1),
            time
        };
        point.interval = previous ? time - previous.time : time;
        point.deltaX = previous ? point.x - previous.x : 0;
        point.deltaY = previous ? point.y - previous.y : 0;
        point.change = Math.max(Math.abs(point.deltaX), Math.abs(point.deltaY));
        point.speed = point.interval > 0
            ? Math.hypot(point.deltaX, point.deltaY) / (point.interval / 1000)
            : 0;
        trackingData.push(point);
        drawPreviewPoint(point);
    }

    function samplePosition() {
        recordPosition(performance.now() - captureStartedAt);
    }

    function detachSessionPanel() {
        const rect = sessionPanel.getBoundingClientRect();
        sessionPlaceholder = document.createElement("span");
        sessionPlaceholder.setAttribute("aria-hidden", "true");
        sessionPlaceholder.style.cssText = `display: block; grid-column: 2; width: ${rect.width}px; height: ${rect.height}px;`;
        sessionPanel.replaceWith(sessionPlaceholder);
        sessionPanel.classList.add("capture-session-detached");
        document.body.appendChild(sessionPanel);
    }

    function returnSessionPanel() {
        sessionPanel.classList.remove("capture-session-detached");
        if (sessionPlaceholder && sessionPlaceholder.isConnected) {
            sessionPlaceholder.replaceWith(sessionPanel);
        }
        sessionPlaceholder = null;
    }

    function centerDetachedStopButton() {
        const rect = stopButton.getBoundingClientRect();
        stopButton.style.transform = `translate3d(${(window.innerWidth - rect.width) / 2}px, ${(window.innerHeight - rect.height) / 2}px, 0)`;
    }

    function detachStopButton() {
        const rect = stopButton.getBoundingClientRect();
        stopPlaceholder = document.createElement("span");
        stopPlaceholder.setAttribute("aria-hidden", "true");
        stopPlaceholder.style.cssText = `display: block; flex: 0 0 ${rect.width}px; width: ${rect.width}px; height: ${rect.height}px;`;
        stopButton.replaceWith(stopPlaceholder);
        stopButton.classList.add("capture-stop-detached");
        stopButton.style.width = `${Math.max(rect.width, 240)}px`;
        stopButton.style.height = `${rect.height}px`;
        stopButton.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
        document.body.appendChild(stopButton);
        void stopButton.offsetWidth;
        requestAnimationFrame(() => {
            if (capturing || preparingCapture) centerDetachedStopButton();
        });
    }

    function returnStopButton() {
        const target = stopPlaceholder
            ? stopPlaceholder.getBoundingClientRect()
            : stopButtonHome.getBoundingClientRect();
        let returned = false;

        const finishReturn = () => {
            if (returned) return;
            returned = true;
            window.clearTimeout(stopReturnTimer);
            stopButton.removeEventListener("transitionend", onStopTransitionEnd);
            stopButton.classList.remove("capture-stop-detached");
            stopButton.classList.remove("capture-stop-returning");
            stopButton.style.removeProperty("transform");
            stopButton.style.removeProperty("opacity");
            stopButton.style.removeProperty("width");
            stopButton.style.removeProperty("height");
            if (stopPlaceholder && stopPlaceholder.isConnected) {
                stopPlaceholder.replaceWith(stopButton);
            } else {
                stopButtonHome.appendChild(stopButton);
            }
            stopButton.disabled = true;
            stopPlaceholder = null;
            startButton.disabled = false;
        };

        const onStopTransitionEnd = event => {
            if (event.propertyName === "transform") finishReturn();
        };

        stopButton.addEventListener("transitionend", onStopTransitionEnd);
        stopButton.classList.add("capture-stop-returning");
        stopButton.style.transform = `translate3d(${target.left}px, ${target.top}px, 0)`;
        stopReturnTimer = window.setTimeout(finishReturn, 700);
    }

    function finishCapture(message, discardRecentData = false) {
        if (!capturing) return;
        const actualElapsed = performance.now() - captureStartedAt;
        const elapsed = Math.min(CAPTURE_DURATION, actualElapsed);
        capturing = false;
        window.clearInterval(sampleTimer);
        sampleTimer = null;
        returnSessionPanel();
        app.classList.remove("is-capturing");
        sessionPanel.classList.remove("is-capturing");
        stopButton.disabled = true;
        stopButton.classList.remove("capture-stop-active");
        stopButtonLabel.textContent = "Stop & create art";
        stopButtonHint.hidden = true;
        sessionState.textContent = "Artwork generated";
        updateSession(elapsed);
        const cutoff = actualElapsed - MANUAL_STOP_TAIL;
        renderedTrackingData = discardRecentData
            ? trackingData.filter(point => point.time <= cutoff)
            : trackingData.slice();
        drawArtwork(renderedTrackingData);
        setControlsMinimized(true);
        setStatus(`Rendered ${renderedTrackingData.length} of ${trackingData.length} captured samples. Adjust the palette or download the PNG.`);
        if (message) setStatus(`${message} ${renderedTrackingData.length} of ${trackingData.length} captured samples were rendered.`);
        returnStopButton();
    }

    function beginTimedCapture() {
        preparingCapture = false;
        window.clearInterval(preparationTimer);
        preparationTimer = null;
        stopButton.classList.remove("capture-stop-priming");
        stopButton.classList.add("capture-stop-active");
        stopButton.style.removeProperty("width");
        stopButton.style.removeProperty("height");
        stopButtonLabel.textContent = "Move naturally. Leave a little of yourself in the image.";
        stopButtonHint.textContent = "Click here to stop and create art.";
        stopButtonHint.hidden = false;
        void stopButton.offsetWidth;
        centerDetachedStopButton();
        primingCount.hidden = true;
        stopButton.disabled = false;
        capturing = true;
        captureStartedAt = performance.now();
        recordPosition(0);
        sessionState.textContent = "Recording movement";
        updateSession(0);
        setStatus("Follow the movement. Your captured coordinates will shape the final layered artwork.");
        sampleTimer = window.setInterval(() => {
            samplePosition();
            const elapsed = performance.now() - captureStartedAt;
            updateSession(elapsed);
            if (elapsed >= CAPTURE_DURATION) finishCapture();
        }, SAMPLE_INTERVAL);
    }

    function beginCapture() {
        if (capturing || preparingCapture) return;
        if (hasStartedCapture) captureNumber += 1;
        hasStartedCapture = true;
        traceNumber.textContent = String(captureNumber).padStart(2, "0");
        trackingData = [];
        renderedTrackingData = [];
        preparingCapture = true;
        preparationStartedAt = performance.now();
        app.classList.add("is-capturing");
        sessionPanel.classList.add("is-capturing");
        startButton.disabled = true;
        stopButton.disabled = true;
        stopButton.classList.add("capture-stop-priming");
        stopButtonLabel.textContent = "Pick a start point";
        stopButtonHint.hidden = true;
        primingCount.hidden = false;
        primingCount.textContent = "5";
        detachSessionPanel();
        detachStopButton();
        sessionState.textContent = "Choose a start point";
        updateSession(0);
        setStatus("Choose where your movement will begin. The 20-second capture starts after the countdown.");
        drawBackground([]);
        preparationTimer = window.setInterval(() => {
            const elapsed = performance.now() - preparationStartedAt;
            const seconds = Math.max(1, Math.ceil((START_POINT_DURATION - elapsed) / 1000));
            primingCount.textContent = String(seconds);
            if (elapsed >= START_POINT_DURATION) beginTimedCapture();
        }, SAMPLE_INTERVAL);
    }

    function drawBackground(points) {
        const averageX = points.length
            ? points.reduce((sum, point) => sum + point.x, 0) / points.length
            : 0.5;
        const averageY = points.length
            ? points.reduce((sum, point) => sum + point.y, 0) / points.length
            : 0.5;
        const hue = paletteHue(0, averageX * 45);
        const saturation = clamp((24 + averageY * 38) * (palette.saturation / 70), 0, 100);
        const lightness = clamp(8 + palette.lightness * 0.2, 2, 22);
        context.globalCompositeOperation = "source-over";
        context.fillStyle = colorFor(hue, saturation, lightness, 1);
        context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

        const glow = context.createRadialGradient(
            OUTPUT_WIDTH * averageX, OUTPUT_HEIGHT * averageY, 0,
            OUTPUT_WIDTH * averageX, OUTPUT_HEIGHT * averageY, OUTPUT_WIDTH * 0.78
        );
        glow.addColorStop(0, colorFor(hue + 36, saturation + 10, lightness + 17, 0.52));
        glow.addColorStop(0.45, colorFor(hue - 24, saturation, lightness + 7, 0.18));
        glow.addColorStop(1, colorFor(hue - 35, saturation, lightness, 0));
        context.fillStyle = glow;
        context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    }

    function drawPreviewPoint(point) {
        drawCoordinateGradient(point, true);
    }

    function drawCoordinateGradient(point, preview = false) {
        const x = point.x * OUTPUT_WIDTH;
        const y = point.y * OUTPUT_HEIGHT;
        const hue = paletteHue(trackingData.length, point.x * 24);
        const radius = OUTPUT_WIDTH * (preview ? 0.012 : 0.025);
        const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, colorFor(hue, palette.saturation, 68 + palette.lightness, preview ? 0.3 : 0.42));
        gradient.addColorStop(0.42, colorFor(paletteHue(trackingData.length + 1, 8), palette.saturation, 58 + palette.lightness, preview ? 0.14 : 0.2));
        gradient.addColorStop(1, colorFor(paletteHue(trackingData.length + 2, 12), palette.saturation, 45 + palette.lightness, 0));
        context.save();
        context.globalCompositeOperation = "screen";
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = gradient;
        context.fill();
        context.restore();
    }

    function seededRandom(seed) {
        let value = seed >>> 0;
        return () => {
            value = (value * 1664525 + 1013904223) >>> 0;
            return value / 4294967296;
        };
    }

    function setControlsMinimized(minimized) {
        const position = controls.getBoundingClientRect();
        controls.classList.toggle("is-minimized", minimized);
        if (minimized) setControlsPosition(position.left, position.top);
        minimizeButton.textContent = minimized ? "□" : "−";
        minimizeButton.setAttribute("aria-label", minimized ? "Expand controls" : "Minimize controls");
        minimizeButton.title = minimized ? "Expand controls" : "Minimize controls";
    }

    function drawArtwork(points) {
        drawBackground(points);
        if (!points.length) return;
        const scale = OUTPUT_WIDTH / 1000;
        const seed = points.length * 7919 + palette.hue * 31 + palette.saturation * 17 + palette.lightness * 13;
        const random = seededRandom(seed);
        context.save();
        context.lineCap = "round";
        context.lineJoin = "round";

        points.forEach((point, index) => {
            const x = point.x * OUTPUT_WIDTH;
            const y = point.y * OUTPUT_HEIGHT;
            const hue = paletteHue(index, point.x * 35 + Math.sin(index * 0.09) * 12);
            const saturation = clamp((38 + point.y * 58) * (palette.saturation / 70), 0, 100);
            const lightness = clamp(50 + Math.sin(index * 0.17) * 17 + palette.lightness, 4, 92);
            const elementScale = 0.55 + random() * 1.15;
            const rotation = (random() * 2 - 1) * Math.PI;
            const radius = (20 + random() * 46 + Math.abs(Math.sin(index * 0.13)) * 38) * scale;

            const radialRadius = radius * elementScale;
            const radial = context.createRadialGradient(x, y, radialRadius * 0.03, x, y, radialRadius * 2.7);
            radial.addColorStop(0, colorFor(hue, saturation, lightness + 18, 0.78));
            radial.addColorStop(0.26, colorFor(hue + 28, saturation, lightness + 5, 0.42));
            radial.addColorStop(0.62, colorFor(hue + 68, saturation * 0.86, lightness, 0.16));
            radial.addColorStop(1, colorFor(hue + 115, saturation, lightness, 0));
            context.globalCompositeOperation = index % 4 === 0 ? "multiply" : "screen";
            context.fillStyle = radial;
            context.beginPath();
            context.arc(x, y, radialRadius * 2.7, 0, Math.PI * 2);
            context.fill();

            const wobbleX = (random() - 0.5) * radius * 1.3;
            const wobbleY = (random() - 0.5) * radius * 1.3;
            const phase = index * 0.23;
            context.save();
            context.translate(x, y);
            context.rotate(rotation);
            context.scale(elementScale, elementScale);
            context.globalCompositeOperation = index % 3 === 0 ? "overlay" : "screen";
            context.fillStyle = colorFor(hue + 55, saturation * 0.9, lightness + 12, 0.24);
            context.beginPath();
            context.moveTo(wobbleX, -radius);
            context.bezierCurveTo(
                radius * Math.cos(phase), -radius * 0.2,
                radius * 0.3, radius * Math.sin(phase) + wobbleY,
                -wobbleX * 0.5, radius
            );
            context.bezierCurveTo(
                -radius * 1.4, radius * 0.35,
                -radius * 0.8, -radius * 0.85,
                wobbleX, -radius
            );
            context.closePath();
            context.fill();
            context.restore();

            if (index > 0) {
                const previous = points[index - 1];
                const previousX = previous.x * OUTPUT_WIDTH;
                const previousY = previous.y * OUTPUT_HEIGHT;
                const deltaX = x - previousX;
                const deltaY = y - previousY;
                const distance = Math.hypot(deltaX, deltaY);
                const curveAngle = (random() - 0.5) * Math.PI;
                const curveScale = 0.08 + random() * 0.42;
                const curveOffset = distance * curveScale;
                const bendX = (-deltaY / (distance || 1) * Math.cos(curveAngle)
                    - deltaX / (distance || 1) * Math.sin(curveAngle)) * curveOffset;
                const bendY = (deltaX / (distance || 1) * Math.cos(curveAngle)
                    - deltaY / (distance || 1) * Math.sin(curveAngle)) * curveOffset;
                const linear = context.createLinearGradient(previousX, previousY, x, y);
                linear.addColorStop(0, colorFor(paletteHue(index - 1, previous.x * 35), saturation, lightness + 12, 0.08));
                linear.addColorStop(0.42, colorFor(hue, saturation, lightness + 12, 0.72));
                linear.addColorStop(1, colorFor(paletteHue(index + 1, point.x * 35), saturation, lightness + 8, 0.08));

                context.globalCompositeOperation = index % 5 === 0 ? "multiply" : "screen";
                context.strokeStyle = linear;
                context.lineWidth = (1.5 + random() * 5 + Math.min(point.speed, 1.5) * 2.4) * scale
                    * (0.65 + random() * 1.2);
                context.beginPath();
                context.moveTo(previousX, previousY);
                context.quadraticCurveTo(
                    (previousX + x) / 2 + bendX,
                    (previousY + y) / 2 + bendY,
                    x,
                    y
                );
                context.stroke();

                if (index % 3 === 0) {
                    const clusterX = x + (random() - 0.5) * radius * 1.8;
                    const clusterY = y + (random() - 0.5) * radius * 1.8;
                    const clusterRadius = radius * (0.12 + random() * 0.2);
                    const cluster = context.createRadialGradient(clusterX, clusterY, 0, clusterX, clusterY, clusterRadius);
                    cluster.addColorStop(0, colorFor(hue + 145, saturation, lightness + 25, 0.5));
                    cluster.addColorStop(1, colorFor(hue + 190, saturation, lightness, 0));
                    context.globalCompositeOperation = "screen";
                    context.fillStyle = cluster;
                    context.beginPath();
                    context.arc(clusterX, clusterY, clusterRadius, 0, Math.PI * 2);
                    context.fill();
                }
            }
        });
        context.restore();
        context.globalCompositeOperation = "source-over";
    }

    function redrawArtwork() {
        if (!capturing) {
            drawArtwork(renderedTrackingData);
            return;
        }
        drawBackground([]);
        trackingData.forEach(point => drawCoordinateGradient(point, true));
    }

    const debouncedPaletteRender = debounce(redrawArtwork, 160);
    const debouncedPaletteChange = debounce(rotatePalette, 220);

    function applyPalette() {
        palette = {
            hue: Number(hueControl.value),
            saturation: Number(saturationControl.value),
            lightness: Number(lightnessControl.value)
        };
        updatePaletteControls();
        debouncedPaletteRender();
    }

    function previewPaletteValues() {
        updatePaletteReadout({
            hue: Number(hueControl.value),
            saturation: Number(saturationControl.value),
            lightness: Number(lightnessControl.value)
        });
    }

    function rotatePalette() {
        const hueRotation = 30 + Math.floor(Math.random() * 301);
        const saturationRotation = 5 + Math.floor(Math.random() * 21);
        const lightnessRotation = 4 + Math.floor(Math.random() * 13);
        palette.hue = wrapHue(palette.hue + hueRotation);
        palette.saturation = clamp(
            palette.saturation + (Math.random() < 0.5 ? -saturationRotation : saturationRotation),
            0,
            100
        );
        palette.lightness = clamp(
            palette.lightness + (Math.random() < 0.5 ? -lightnessRotation : lightnessRotation),
            -30,
            30
        );
        hueControl.value = String(palette.hue);
        saturationControl.value = String(palette.saturation);
        lightnessControl.value = String(palette.lightness);
        updatePaletteControls();
        debouncedPaletteRender();
        setStatus(`Palette rotated: hue ${hueRotation}°, saturation ${saturationRotation} points, lightness ${lightnessRotation} points.`);
    }

    function downloadArtwork() {
        try {
            const link = document.createElement("a");
            const date = new Date();
            const dateStamp = [
                String(date.getMonth() + 1).padStart(2, "0"),
                String(date.getDate()).padStart(2, "0"),
                String(date.getFullYear()).slice(-2)
            ].join("-");
            const captureStamp = String(captureNumber).padStart(2, "0");
            link.download = `computational-background-${dateStamp}-${captureStamp}.png`;
            link.href = canvas.toDataURL("image/png");
            link.hidden = true;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setStatus("Your 3840 × 2160 wallpaper download has started.");
        } catch (error) {
            setStatus(`Could not export the wallpaper: ${error.message}`);
        }
    }

    window.addEventListener("pointermove", event => {
        latestPosition = {
            x: event.clientX / Math.max(window.innerWidth, 1),
            y: event.clientY / Math.max(window.innerHeight, 1)
        };
    }, { passive: true });

    window.addEventListener("resize", () => {
        if ((capturing || preparingCapture) && stopButton.classList.contains("capture-stop-detached")) {
            centerDetachedStopButton();
        }
    });

    dragHandle.addEventListener("pointerdown", beginControlsDrag);
    dragHandle.addEventListener("pointermove", moveControls);
    dragHandle.addEventListener("pointerup", endControlsDrag);
    dragHandle.addEventListener("pointercancel", endControlsDrag);
    dragHandle.addEventListener("keydown", nudgeControls);
    minimizeButton.addEventListener("click", () => {
        setControlsMinimized(!controls.classList.contains("is-minimized"));
    });
    startButton.addEventListener("click", beginCapture);
    stopButton.addEventListener("click", () => finishCapture("Capture stopped. The final 2 seconds were excluded from the artwork.", true));
    downloadButton.addEventListener("click", downloadArtwork);
    paletteButton.addEventListener("click", debouncedPaletteChange);
    // Range input previews the values; change commits and renders after the pointer is released.
    [hueControl, saturationControl, lightnessControl].forEach(control => {
        control.addEventListener("input", previewPaletteValues);
        control.addEventListener("change", applyPalette);
    });

    updatePaletteControls();
    updateSession();
    drawArtwork(renderedTrackingData);
})();
