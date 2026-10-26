// Photoshop style brush adjustment: hold Alt and drag with the right mouse button over the viewport or the 2D editor.
// Dragging sideways changes the brush size so its edge follows the mouse, dragging down makes it softer and up harder.
// The brush outline stays where the drag started and shows the new size live.

type Gesture = {
	tool: Tool
	start: [number, number]
	pointer_id: number
	start_size: number
	start_softness: number | null
	preview: Preview | null
	in_uv_editor: boolean
	// Screen pixels per texture pixel where the drag started
	pixels_per_texel: number
	changed: boolean
}
let gesture: Gesture | null = null;
// At most two brush sizes per screen pixel of dragging
const MIN_PIXELS_PER_TEXEL = 1;
// After the gesture, the rest of the right click shouldn't reach the viewport, which would open the context menu.
// Only the release of the pointer that did the gesture is held back, and only briefly: browsers skip the mouse events
// after a canceled pointerdown, and pens may never send them, so waiting for them would block every later release
// and leave the painter drawing
const RELEASE_WINDOW = 400;
let release_pointer: number | null = null;
let quiet_until = 0;
function holdBackRelease(pointer_id: number | null) {
	release_pointer = pointer_id;
	quiet_until = performance.now() + RELEASE_WINDOW;
}

function getBrushTool(): Tool | null {
	if (!Modes.paint) return null;
	let tool = Toolbox.selected;
	// Holding Alt in Paint mode swaps to the color picker, so adjust the brush it was swapped from
	if (!tool.brush?.size && Toolbox.original?.brush?.size) tool = Toolbox.original;
	return tool.brush?.size ? tool : null;
}

function getPixelsPerTexel(preview: Preview | null, in_uv_editor: boolean, start: [number, number]): number {
	if (in_uv_editor) {
		let texture = UVEditor.texture;
		if (texture?.width) return UVEditor.vue.inner_width / texture.width;
		return 4;
	}
	// Measure the brush outline as drawn at the start of the drag: a 1x1 plane scaled to the brush size
	let outline = Canvas.brush_outline;
	if (preview && outline?.parent && outline.visible !== false) {
		outline.updateMatrixWorld(true);
		let a = preview.vectorToScreenPosition(new THREE.Vector3(-0.5, 0, 0).applyMatrix4(outline.matrixWorld));
		let b = preview.vectorToScreenPosition(new THREE.Vector3(0.5, 0, 0).applyMatrix4(outline.matrixWorld));
		let size = Math.max(BarItems.slider_brush_size.get() as number, 1);
		let pixels = Math.hypot(b.x - a.x, b.y - a.y) / size;
		if (pixels > 0.01) return pixels;
	}
	// Without the 3D brush outline, place two neighboring texture pixels on the surface under the mouse
	// the same way the outline would be placed, and measure how far apart they are on screen
	if (preview) {
		let [clientX, clientY] = start;
		let data = preview.raycast({clientX, clientY} as MouseEvent);
		let intersect = data && data.type == 'element' ? data.intersects?.[0] : null;
		let face = intersect && (data as any).element.faces?.[(data as any).face];
		let texture = face?.getTexture?.();
		if (intersect?.uv && texture && typeof face.texelToLocalMatrix == 'function') {
			let uv_factor_x = texture.getUVWidth() / texture.width;
			let uv_factor_y = texture.getUVHeight() / texture.display_height;
			let x = intersect.uv.x * texture.width;
			let y = (1 - intersect.uv.y) * texture.height;
			let texelPosition = (tx: number) => {
				let coords = [tx * uv_factor_x, y * uv_factor_y];
				let matrix = face.texelToLocalMatrix(coords, [uv_factor_x, uv_factor_y], coords);
				let position = new THREE.Vector3().setFromMatrixPosition(matrix);
				return intersect.object.localToWorld(position);
			}
			let a = preview.vectorToScreenPosition(texelPosition(x));
			let b = preview.vectorToScreenPosition(texelPosition(x + 1));
			let pixels = Math.hypot(b.x - a.x, b.y - a.y);
			if (pixels > 0.01) return pixels;
		}
	}
	return 4;
}

function redrawOutline() {
	if (!gesture) return;
	if (gesture.in_uv_editor) {
		UVEditor.vue.$forceUpdate();
	} else if (gesture.preview) {
		let [clientX, clientY] = gesture.start;
		gesture.preview.mousemove({clientX, clientY, target: gesture.preview.canvas} as unknown as MouseEvent);
	}
}

function showReadout() {
	if (!gesture) return;
	let text = tl('action.slider_brush_size') + ' ' + BarItems.slider_brush_size.get();
	if (gesture.start_softness != null) {
		text += '  ·  ' + tl('action.slider_brush_softness') + ' ' + Math.round(BarItems.slider_brush_softness.get() as number) + '%';
	}
	Blockbench.setCursorTooltip(text);
}

function start(event: PointerEvent, preview: Preview | null, in_uv_editor: boolean, tool: Tool) {
	if (Toolbox.selected !== tool) {
		tool.select();
		delete Toolbox.original;
	}
	gesture = {
		tool,
		start: [event.clientX, event.clientY],
		pointer_id: event.pointerId,
		start_size: BarItems.slider_brush_size.get() as number,
		start_softness: tool.brush.softness ? BarItems.slider_brush_softness.get() as number : null,
		preview,
		in_uv_editor,
		pixels_per_texel: 4,
		changed: false,
	};
	redrawOutline();
	// Keep it controllable when the texture pixels are tiny on screen
	gesture.pixels_per_texel = Math.max(getPixelsPerTexel(preview, in_uv_editor, gesture.start), MIN_PIXELS_PER_TEXEL);
	showReadout();
}

function move(event: MouseEvent) {
	let dx = event.clientX - gesture.start[0];
	let dy = event.clientY - gesture.start[1];
	// The size is a diameter, so moving the mouse by one radius changes it by twice as much
	let size = Math.round(gesture.start_size + 2 * dx / gesture.pixels_per_texel);
	BarItems.slider_brush_size.setValue(Math.clamp(size, 1, 1024));
	if (gesture.start_softness != null) {
		let softness = Math.round(gesture.start_softness + dy * 0.5);
		BarItems.slider_brush_softness.setValue(Math.clamp(softness, 0, 100));
	}
	gesture.changed = true;
	redrawOutline();
	showReadout();
}

function end(cancel: boolean) {
	if (!gesture) return;
	if (cancel) {
		BarItems.slider_brush_size.setValue(gesture.start_size);
		if (gesture.start_softness != null) BarItems.slider_brush_softness.setValue(gesture.start_softness);
		redrawOutline();
	}
	gesture = null;
	Blockbench.setCursorTooltip();
}

window.addEventListener('pointerdown', (event: PointerEvent) => {
	if (gesture || event.button !== 2 || !event.altKey) return;
	let target = event.target as HTMLElement;
	let preview = Preview.all.find(preview => preview.canvas === target) ?? null;
	let in_uv_editor = !preview && !!target.closest?.('#uv_viewport');
	if (!preview && !in_uv_editor) return;
	let tool = getBrushTool();
	if (!tool) return;
	// Keep the camera and the 2D editor from reacting to the right mouse button
	event.preventDefault();
	event.stopImmediatePropagation();
	start(event, preview, in_uv_editor, tool);
}, true);

for (let type of ['pointermove', 'mousemove']) {
	window.addEventListener(type, (event: MouseEvent) => {
		if (!gesture) return;
		event.stopImmediatePropagation();
		if (type == 'pointermove') move(event);
	}, true);
}
window.addEventListener('mousedown', (event: MouseEvent) => {
	if (!gesture) return;
	event.preventDefault();
	event.stopImmediatePropagation();
}, true);
window.addEventListener('pointerup', (event: PointerEvent) => {
	if (gesture && event.pointerId === gesture.pointer_id) {
		event.stopImmediatePropagation();
		holdBackRelease(null);
		end(false);
	} else if (!gesture && release_pointer !== null && event.pointerId === release_pointer) {
		// Released after the gesture was canceled with Escape
		event.stopImmediatePropagation();
		holdBackRelease(null);
	}
}, true);
window.addEventListener('mouseup', (event: MouseEvent) => {
	if (gesture || (event.button === 2 && performance.now() < quiet_until)) {
		event.stopImmediatePropagation();
	}
}, true);
window.addEventListener('contextmenu', (event: MouseEvent) => {
	if (gesture || performance.now() < quiet_until) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}, true);
// Alt keeps repeating while held, and each repeat would swap the brush to the color picker again, hiding the outline
for (let type of ['keydown', 'keyup']) {
	window.addEventListener(type, (event: KeyboardEvent) => {
		if (gesture && event.key == 'Alt') {
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	}, true);
}
// The 2D editor hides its brush outline when the pointer leaves it, for example when crossing the readout
for (let type of ['mouseleave', 'mouseout', 'pointerleave', 'pointerout']) {
	window.addEventListener(type, (event: Event) => {
		if (gesture) event.stopImmediatePropagation();
	}, true);
}
window.addEventListener('keydown', (event: KeyboardEvent) => {
	if (gesture && event.key == 'Escape') {
		event.preventDefault();
		event.stopImmediatePropagation();
		holdBackRelease(gesture.pointer_id);
		end(true);
	}
}, true);
window.addEventListener('blur', () => end(false));

export {};
