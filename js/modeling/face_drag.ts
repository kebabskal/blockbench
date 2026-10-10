import { canvasGridSize } from "../misc";
import { adjustFromAndToForInflateAndStretch } from "../outliner/types/cube";
import { Preview, type RaycastResult } from "../preview/preview";

// Face Drag tool: grab a cube face in the viewport and drag it directly.
// Dragging moves the cube along the plane of the face, Shift + drag pushes or pulls the face to resize the cube.

const FACE_AXES: Record<string, [number, 1 | -1]> = {
	east: [0, 1],
	west: [0, -1],
	up: [1, 1],
	down: [1, -1],
	south: [2, 1],
	north: [2, -1],
};
const AXIS_LETTERS = ['x', 'y', 'z'] as const;

type StartValues = {
	from?: ArrayVector3
	to?: ArrayVector3
	origin?: ArrayVector3
	position?: ArrayVector3
	uv_offset?: ArrayVector2
}
type DragState = {
	mode: 'move' | 'resize'
	cube: Cube
	face: string
	axis: number
	direction: 1 | -1
	start_point: THREE.Vector3
	normal: THREE.Vector3
	plane: THREE.Plane
	start_mouse: [number, number]
	elements: OutlinerElement[]
	start_values: Map<OutlinerElement, StartValues>
	changed: boolean
	value: number
}

let drag: DragState | null = null;
let highlight: THREE.Object3D | null = null;
let cursor_mode: 'move' | 'resize' | null = null;

function getRay(preview: Preview, event: MouseEvent): THREE.Ray {
	let canvas_offset = preview.canvas.getBoundingClientRect();
	let mouse = new THREE.Vector2(
		((event.clientX - canvas_offset.left) / preview.width) * 2 - 1,
		- ((event.clientY - canvas_offset.top) / preview.height) * 2 + 1
	);
	let raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(mouse, preview.camera);
	if (preview.isOrtho) {
		raycaster.ray.origin.set(mouse.x, mouse.y, -1).unproject(preview.camera);
	}
	return raycaster.ray;
}

function getFaceCorners(cube: Cube, face: string): THREE.Vector3[] {
	let [axis, direction] = FACE_AXES[face];
	let from = cube.from.slice() as ArrayVector3;
	let to = cube.to.slice() as ArrayVector3;
	adjustFromAndToForInflateAndStretch(from, to, cube);
	for (let i = 0; i < 3; i++) {
		from[i] -= cube.origin[i];
		to[i] -= cube.origin[i];
	}
	let [b, c] = [0, 1, 2].filter(i => i != axis);
	// Lift the highlight off the face slightly to avoid z-fighting
	let level = (direction == 1 ? Math.max(from[axis], to[axis]) : Math.min(from[axis], to[axis])) + direction * 0.02;
	let corners = [[from[b], from[c]], [to[b], from[c]], [to[b], to[c]], [from[b], to[c]]];
	return corners.map(([vb, vc]) => {
		let vec = new THREE.Vector3();
		vec.setComponent(axis, level);
		vec.setComponent(b, vb);
		vec.setComponent(c, vc);
		return vec;
	})
}

function showHighlight(cube: Cube, face: string) {
	removeHighlight();
	let color = Canvas.gizmo_colors.outline;
	let corners = getFaceCorners(cube, face);

	let fill_geometry = new THREE.BufferGeometry().setFromPoints([corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]]);
	let fill = new THREE.Mesh(fill_geometry, new THREE.MeshBasicMaterial({
		color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
		polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
	}));
	let line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({
		color, transparent: true, depthTest: false,
	}));
	line.renderOrder = 900;
	fill.renderOrder = 899;

	highlight = new THREE.Object3D();
	// @ts-expect-error
	highlight.exclude_from_effects = true;
	highlight.add(fill, line);
	highlight.traverse(object => {
		object.no_export = true;
	})
	cube.mesh.add(highlight);
}
function removeHighlight() {
	if (!highlight) return;
	highlight.parent?.remove(highlight);
	highlight.traverse(object => {
		if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
			object.geometry.dispose();
			(object.material as THREE.Material).dispose();
		}
	})
	highlight = null;
}
function setCursor(mode: 'move' | 'resize' | null) {
	if (cursor_mode == mode) return;
	cursor_mode = mode;
	$('#preview').css('cursor', mode == 'move' ? 'move' : (mode == 'resize' ? 'ns-resize' : ''));
}

function storeStartValues(element: OutlinerElement): StartValues {
	let values: StartValues = {};
	for (let key of ['from', 'to', 'origin', 'position', 'uv_offset']) {
		if (element[key] instanceof Array) values[key] = element[key].slice();
	}
	return values;
}
function restoreStartValues(element: OutlinerElement, values: StartValues) {
	for (let key in values) {
		element[key].replace(values[key]);
	}
}

function getDraggedElements(cube: Cube, mode: 'move' | 'resize'): OutlinerElement[] {
	let selected = Outliner.selected.filter(el => !el.locked);
	if (!selected.includes(cube)) selected = [cube];
	if (mode == 'resize') {
		return selected.filter(el => el instanceof Cube);
	}
	return selected.filter(el => {
		if (el.getTypeBehavior('movable') == false) return false;
		// Children move along with a selected parent
		if (el.parent instanceof OutlinerElement && selected.includes(el.parent)) return false;
		return el['from'] instanceof Array || el['position'] instanceof Array;
	});
}

function startDrag(data: RaycastResult) {
	let event = data.event as PointerEvent;
	let cube = data.element as Cube;
	let [axis, direction] = FACE_AXES[data.face];
	let mesh = cube.mesh;
	mesh.updateMatrixWorld();

	let normal = new THREE.Vector3().setComponent(axis, direction).transformDirection(mesh.matrixWorld);
	let start_point = data.intersects[0].point.clone();
	let mode: 'move' | 'resize' = (event.shiftKey || Pressing.overrides.shift) ? 'resize' : 'move';
	let elements = getDraggedElements(cube, mode);
	if (!elements.length) return;

	drag = {
		mode,
		cube,
		face: data.face,
		axis,
		direction,
		start_point,
		normal,
		plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, start_point),
		start_mouse: [event.clientX, event.clientY],
		elements,
		start_values: new Map(),
		changed: false,
		value: 0,
	};
	for (let element of elements) {
		drag.start_values.set(element, storeStartValues(element));
		if (mode == 'resize') {
			let el = element as Cube;
			el.temp_data.old_size = el.size();
			el.temp_data.oldCenter = el.from.map((from, i) => (from + el.to[i]) / 2);
			if (el.uv_offset) el.temp_data.oldUVOffset = el.uv_offset.slice();
		}
	}
	Undo.initEdit({elements});
	showHighlight(cube, data.face);
	setCursor(mode);

	document.addEventListener('pointermove', onDragMove);
	document.addEventListener('pointerup', onDragEnd);
	document.addEventListener('keydown', onDragKey, true);
}

function getResizeDistance(event: PointerEvent, preview: Preview): number | null {
	let {start_point, normal} = drag;
	let ray = getRay(preview, event);

	if (Math.abs(ray.direction.dot(normal)) > 0.96) {
		// Looking straight at the face, so the drag line has no screen length. Use vertical mouse movement instead
		let up = new THREE.Vector3(0, 1, 0).applyQuaternion(preview.camera.quaternion);
		let a = preview.vectorToScreenPosition(start_point);
		let b = preview.vectorToScreenPosition(start_point.clone().add(up));
		let pixels_per_unit = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 0.001);
		return (drag.start_mouse[1] - event.clientY) / pixels_per_unit;
	}
	// Closest point between the mouse ray and the line through the face along its normal
	let w0 = start_point.clone().sub(ray.origin);
	let b = normal.dot(ray.direction);
	let d = normal.dot(w0);
	let e = ray.direction.dot(w0);
	let denominator = 1 - b * b;
	if (denominator < 1e-6) return null;
	return (b * e - d) / denominator;
}

function onDragMove(event: PointerEvent) {
	if (!drag) return;
	let preview = Preview.selected;
	if (!preview) return;
	let {cube, axis, direction, start_point} = drag;
	let mesh = cube.mesh;
	let snap = canvasGridSize(false, event.ctrlOrCmd || Pressing.overrides.ctrl);

	if (drag.mode == 'resize') {
		let distance = getResizeDistance(event, preview);
		if (distance == null) return;
		// Convert the world distance into the cube's own units
		let local_start = mesh.worldToLocal(start_point.clone());
		let local_end = mesh.worldToLocal(start_point.clone().addScaledVector(drag.normal, distance));
		let value = (local_end.getComponent(axis) - local_start.getComponent(axis)) * direction;
		value = Math.round(value / snap) * snap;
		if (value == drag.value && drag.changed) return;
		drag.value = value;
		drag.changed = true;

		for (let element of drag.elements) {
			let el = element as Cube;
			restoreStartValues(el, drag.start_values.get(el));
			// resize() takes the offset along the axis, so faces on the negative side grow with a negative value
			el.resize(value * direction, axis, direction == -1);
		}
		Blockbench.setCursorTooltip(trimFloatNumber(value));

	} else {
		let ray = getRay(preview, event);
		// The face plane is seen edge-on, so the intersection would shoot off into the distance
		if (Math.abs(ray.direction.dot(drag.normal)) < 0.05) return;
		let point = ray.intersectPlane(drag.plane, new THREE.Vector3());
		if (!point) return;

		// Snap the offset along the cube's own axes within the face plane
		let local = mesh.worldToLocal(point.clone()).sub(mesh.worldToLocal(start_point.clone()));
		local.setComponent(axis, 0);
		for (let i = 0; i < 3; i++) {
			local.setComponent(i, Math.round(local.getComponent(i) / snap) * snap);
		}
		let world_origin = mesh.localToWorld(new THREE.Vector3());
		let world_offset = mesh.localToWorld(local.clone()).sub(world_origin);
		let value = local.length();
		if (value == drag.value && drag.changed) return;
		drag.value = value;
		drag.changed = true;

		for (let element of drag.elements) {
			let el = element as any;
			restoreStartValues(el, drag.start_values.get(el));
			let parent = el.mesh?.parent;
			if (!parent) continue;
			parent.updateMatrixWorld();
			let offset = parent.worldToLocal(start_point.clone().add(world_offset)).sub(parent.worldToLocal(start_point.clone()));
			if (el.from instanceof Array) {
				el.from.V3_add(offset.x, offset.y, offset.z);
				if (el.to instanceof Array) el.to.V3_add(offset.x, offset.y, offset.z);
				if (el.origin instanceof Array && el.getTypeBehavior('rotatable')) el.origin.V3_add(offset.x, offset.y, offset.z);
			} else if (el.position instanceof Array) {
				el.position.V3_add(offset.x, offset.y, offset.z);
			}
		}
		let parts = [0, 1, 2].filter(i => i != axis && local.getComponent(i)).map(i => AXIS_LETTERS[i].toUpperCase() + ' ' + trimFloatNumber(local.getComponent(i)));
		Blockbench.setCursorTooltip(parts.join('  ') || '0');
	}

	for (let el of drag.elements) {
		el.preview_controller.updateTransform(el);
		el.preview_controller.updateGeometry(el);
		if (el instanceof Cube) el.preview_controller.updateUV(el);
	}
	updateSelection();
	showHighlight(cube, drag.face);
}

function finishDrag(cancel: boolean) {
	if (!drag) return;
	document.removeEventListener('pointermove', onDragMove);
	document.removeEventListener('pointerup', onDragEnd);
	document.removeEventListener('keydown', onDragKey, true);

	let {mode, elements, changed} = drag;
	for (let el of elements) {
		delete el.temp_data.old_size;
		delete el.temp_data.oldCenter;
		delete el.temp_data.oldUVOffset;
	}
	if (cancel && changed) {
		for (let el of elements) {
			restoreStartValues(el, drag.start_values.get(el));
			if (el instanceof Cube) el.mapAutoUV();
			el.preview_controller.updateTransform(el);
			el.preview_controller.updateGeometry(el);
			if (el instanceof Cube) el.preview_controller.updateUV(el);
		}
		updateSelection();
	}
	drag = null;
	Blockbench.setCursorTooltip();

	if (changed && !cancel) {
		Undo.finishEdit(mode == 'resize' ? 'Resize cube face' : 'Move along cube face');
	} else {
		Undo.cancelEdit(false);
	}
	removeHighlight();
	setCursor(null);
}
function onDragEnd(event: PointerEvent) {
	finishDrag(false);
}
function onDragKey(event: KeyboardEvent) {
	if (event.key == 'Escape') {
		event.preventDefault();
		event.stopPropagation();
		finishDrag(true);
	}
}

BARS.defineActions(function() {
	new Tool('face_drag_tool', {
		icon: 'touch_app',
		category: 'tools',
		selectFace: true,
		selectElements: true,
		transformerMode: 'hidden',
		toolbar: 'main_tools',
		modes: ['edit'],
		condition: {modes: ['edit']},
		keybind: new Keybind({key: 'q'}),
		onCanvasClick(data) {
			let event = data?.event as PointerEvent;
			if (!data || drag || !event || event.button !== 0) return;
			if (data.type != 'element' || !(data.element instanceof Cube) || !data.face || !FACE_AXES[data.face]) return;
			if (data.element.locked) return;
			startDrag(data);
		},
		onCanvasMouseMove(data) {
			if (drag) return;
			if (data && data.type == 'element' && data.element instanceof Cube && FACE_AXES[data.face] && !data.element.locked) {
				let event = data.event as MouseEvent;
				showHighlight(data.element, data.face);
				setCursor((event?.shiftKey || Pressing.overrides.shift) ? 'resize' : 'move');
			} else {
				removeHighlight();
				setCursor(null);
			}
		},
		onSelect() {
			Interface.addSuggestedModifierKey('shift', 'modifier_actions.push_pull_face');
			Interface.addSuggestedModifierKey('ctrl', 'modifier_actions.reduced_intensity');
		},
		onUnselect() {
			finishDrag(true);
			removeHighlight();
			setCursor(null);
			Interface.removeSuggestedModifierKey('shift', 'modifier_actions.push_pull_face');
			Interface.removeSuggestedModifierKey('ctrl', 'modifier_actions.reduced_intensity');
		}
	})
})
