import { canvasGridSize } from "../misc";
import { getRotationInterval } from "./transform";
import { adjustFromAndToForInflateAndStretch } from "../outliner/types/cube";
import { Preview, type RaycastResult } from "../preview/preview";

// Face Drag tool: grab a cube face in the viewport and drag it directly.
// Dragging moves the cube along the plane of the face, Alt + drag moves it along the face normal,
// and Shift + drag pushes or pulls the face to resize the cube.
// Near an edge, a handle appears instead. Dragging it rotates the cube around its center, about the axis the edge runs along.

const FACE_AXES: Record<string, [number, 1 | -1]> = {
	east: [0, 1],
	west: [0, -1],
	up: [1, 1],
	down: [1, -1],
	south: [2, 1],
	north: [2, -1],
};
const AXIS_LETTERS = ['x', 'y', 'z'] as const;
// How close the mouse has to be to an edge to grab it, in pixels
const EDGE_GRAB_DISTANCE = 12;

type DragMode = 'move' | 'move_normal' | 'resize' | 'rotate';
type EdgeHit = {
	cube: Cube
	face: string
	// Cube axis the edge runs along, which is the rotation axis
	edge_axis: number
	// Ends of the edge in the cube mesh's local space
	ends: [THREE.Vector3, THREE.Vector3]
}
type StartValues = {
	from?: ArrayVector3
	to?: ArrayVector3
	origin?: ArrayVector3
	position?: ArrayVector3
	uv_offset?: ArrayVector2
	rotation?: ArrayVector3
}
type DragState = {
	mode: DragMode
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
	// Rotation
	edge?: EdgeHit
	center?: THREE.Vector3
	rotation_axis?: THREE.Vector3
	last_mouse?: [number, number]
	angle?: number
}

let drag: DragState | null = null;
let highlight: THREE.Object3D | null = null;
let cursor_mode: string | null = null;

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
function toScreen(preview: Preview, world: THREE.Vector3): THREE.Vector2 {
	let p = preview.vectorToScreenPosition(world);
	return new THREE.Vector2(p.x, p.y);
}
function getMouseOnCanvas(preview: Preview, event: MouseEvent): THREE.Vector2 {
	let rect = preview.canvas.getBoundingClientRect();
	return new THREE.Vector2(event.clientX - rect.left, event.clientY - rect.top);
}
function distanceToSegment(point: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
	let ab = b.clone().sub(a);
	let t = Math.clamp(point.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-6), 0, 1);
	return a.clone().addScaledVector(ab, t).distanceTo(point);
}

/**
 * Lowest and highest corner of the cube in its mesh's local space
 */
function getLocalBox(cube: Cube): [number[], number[]] {
	let from = cube.from.slice() as ArrayVector3;
	let to = cube.to.slice() as ArrayVector3;
	adjustFromAndToForInflateAndStretch(from, to, cube);
	let low = from.map((v, i) => Math.min(v, to[i]) - cube.origin[i]);
	let high = from.map((v, i) => Math.max(v, to[i]) - cube.origin[i]);
	return [low, high];
}

function getFaceCorners(cube: Cube, face: string): THREE.Vector3[] {
	let [axis, direction] = FACE_AXES[face];
	let [low, high] = getLocalBox(cube);
	let [b, c] = [0, 1, 2].filter(i => i != axis);
	// Lift the highlight off the face slightly to avoid z-fighting
	let level = (direction == 1 ? high[axis] : low[axis]) + direction * 0.02;
	let corners = [[low[b], low[c]], [high[b], low[c]], [high[b], high[c]], [low[b], high[c]]];
	return corners.map(([vb, vc]) => {
		let vec = new THREE.Vector3();
		vec.setComponent(axis, level);
		vec.setComponent(b, vb);
		vec.setComponent(c, vc);
		return vec;
	})
}

/**
 * Find the edge of the hovered face that the mouse is close to on screen
 */
function findEdge(data: RaycastResult): EdgeHit | null {
	let preview = Preview.selected;
	let cube = data.element as Cube;
	if (!preview || !Format.rotate_cubes || Format.rotation_limit || !data.event) return null;
	let [axis, direction] = FACE_AXES[data.face];
	let [low, high] = getLocalBox(cube);
	let level = direction == 1 ? high[axis] : low[axis];
	let [b, c] = [0, 1, 2].filter(i => i != axis);
	let point = (i: number, vi: number, j: number, vj: number) => {
		let vec = new THREE.Vector3();
		vec.setComponent(axis, level);
		vec.setComponent(i, vi);
		vec.setComponent(j, vj);
		return vec;
	}
	let edges: [number, THREE.Vector3, THREE.Vector3][] = [
		[b, point(b, low[b], c, low[c]), point(b, high[b], c, low[c])],
		[b, point(b, low[b], c, high[c]), point(b, high[b], c, high[c])],
		[c, point(c, low[c], b, low[b]), point(c, high[c], b, low[b])],
		[c, point(c, low[c], b, high[b]), point(c, high[c], b, high[b])],
	];
	let mesh = cube.mesh;
	mesh.updateMatrixWorld();
	let screen_edges = edges.map(([edge_axis, start, end]) => {
		return [toScreen(preview, mesh.localToWorld(start.clone())), toScreen(preview, mesh.localToWorld(end.clone()))];
	})
	// On small faces, keep most of the face for moving
	let face_span = Math.min(screen_edges[0][0].distanceTo(screen_edges[0][1]), screen_edges[2][0].distanceTo(screen_edges[2][1]));
	let threshold = Math.min(EDGE_GRAB_DISTANCE, face_span * 0.2);

	let mouse = getMouseOnCanvas(preview, data.event as MouseEvent);
	let closest: EdgeHit | null = null;
	let closest_distance = threshold;
	edges.forEach(([edge_axis, start, end], i) => {
		let distance = distanceToSegment(mouse, screen_edges[i][0], screen_edges[i][1]);
		if (distance < closest_distance) {
			closest_distance = distance;
			closest = {cube, face: data.face, edge_axis, ends: [start, end]};
		}
	})
	return closest;
}

function addHighlight(cube: Cube, object: THREE.Object3D) {
	highlight = object;
	// Overlays aren't geometry, so they shouldn't cast AO, cavity or outlines
	// @ts-expect-error
	highlight.exclude_from_effects = true;
	highlight.traverse(object => {
		object.no_export = true;
	})
	cube.mesh.add(highlight);
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

	let group = new THREE.Object3D();
	group.add(fill, line);
	addHighlight(cube, group);
}
function showEdgeHandle(edge: EdgeHit) {
	removeHighlight();
	let preview = Preview.selected;
	let mesh = edge.cube.mesh;
	mesh.updateMatrixWorld();
	let color = Canvas.gizmo_colors.outline;
	let [start, end] = edge.ends;
	let middle = start.clone().add(end).multiplyScalar(0.5);
	let length = start.distanceTo(end);

	// Keep the handle a constant thickness on screen
	let world_middle = mesh.localToWorld(middle.clone());
	let right = new THREE.Vector3(1, 0, 0).applyQuaternion(preview.camera.quaternion);
	let pixels_per_unit = Math.max(toScreen(preview, world_middle).distanceTo(toScreen(preview, world_middle.clone().add(right))), 0.001);
	let world_scale = mesh.getWorldScale(new THREE.Vector3()).x || 1;
	let radius = 2.5 / pixels_per_unit / world_scale;

	let material = new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.95, depthTest: false});
	let bar = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8, 1), material);
	bar.position.copy(middle);
	if (edge.edge_axis == 0) bar.rotation.z = Math.PI / 2;
	if (edge.edge_axis == 2) bar.rotation.x = Math.PI / 2;
	let knobs = [start, end, middle].map((position, i) => {
		let knob = new THREE.Mesh(new THREE.SphereGeometry(radius * (i == 2 ? 3 : 2.2), 12, 8), material);
		knob.position.copy(position);
		return knob;
	})
	let group = new THREE.Object3D();
	group.add(bar, ...knobs);
	group.traverse(object => object.renderOrder = 900);
	addHighlight(edge.cube, group);
}
function removeHighlight() {
	if (!highlight) return;
	highlight.parent?.remove(highlight);
	let materials = new Set<THREE.Material>();
	highlight.traverse(object => {
		if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
			object.geometry.dispose();
			materials.add(object.material as THREE.Material);
		}
	})
	materials.forEach(material => material.dispose());
	highlight = null;
}

const CURSORS = {move: 'move', move_normal: 'ns-resize', resize: 'ns-resize', rotate: 'grab', rotating: 'grabbing'};
function setCursor(mode: keyof typeof CURSORS | null) {
	if (cursor_mode == mode) return;
	cursor_mode = mode;
	$('#preview').css('cursor', CURSORS[mode] ?? '');
}
function getFaceMode(event: MouseEvent): DragMode {
	if (event?.shiftKey || Pressing.overrides.shift) return 'resize';
	if (event?.altKey || Pressing.overrides.alt) return 'move_normal';
	return 'move';
}

function storeStartValues(element: OutlinerElement): StartValues {
	let values: StartValues = {};
	for (let key of ['from', 'to', 'origin', 'position', 'uv_offset', 'rotation']) {
		if (element[key] instanceof Array) values[key] = element[key].slice();
	}
	return values;
}
function restoreStartValues(element: OutlinerElement, values: StartValues) {
	for (let key in values) {
		element[key].replace(values[key]);
	}
}

function getDraggedElements(cube: Cube, mode: DragMode): OutlinerElement[] {
	let selected = Outliner.selected.filter(el => !el.locked);
	if (!selected.includes(cube)) selected = [cube];
	if (mode == 'resize' || mode == 'rotate') {
		return selected.filter(el => el instanceof Cube);
	}
	return selected.filter(el => {
		if (el.getTypeBehavior('movable') == false) return false;
		// Children move along with a selected parent
		if (el.parent instanceof OutlinerElement && selected.includes(el.parent)) return false;
		return el['from'] instanceof Array || el['position'] instanceof Array;
	});
}

function beginDrag(state: DragState) {
	drag = state;
	for (let element of state.elements) {
		state.start_values.set(element, storeStartValues(element));
		if (state.mode == 'resize') {
			let el = element as Cube;
			el.temp_data.old_size = el.size();
			el.temp_data.oldCenter = el.from.map((from, i) => (from + el.to[i]) / 2);
			if (el.uv_offset) el.temp_data.oldUVOffset = el.uv_offset.slice();
		}
	}
	Undo.initEdit({elements: state.elements});
	document.addEventListener('pointermove', onDragMove);
	document.addEventListener('pointerup', onDragEnd);
	document.addEventListener('keydown', onDragKey, true);
}

function startFaceDrag(data: RaycastResult) {
	let event = data.event as PointerEvent;
	let cube = data.element as Cube;
	let [axis, direction] = FACE_AXES[data.face];
	let mesh = cube.mesh;
	mesh.updateMatrixWorld();

	let normal = new THREE.Vector3().setComponent(axis, direction).transformDirection(mesh.matrixWorld);
	let start_point = data.intersects[0].point.clone();
	let mode = getFaceMode(event);
	let elements = getDraggedElements(cube, mode);
	if (!elements.length) return;

	beginDrag({
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
	});
	showHighlight(cube, data.face);
	setCursor(mode);
}

function startRotate(edge: EdgeHit, event: PointerEvent) {
	let cube = edge.cube;
	let mesh = cube.mesh;
	mesh.updateMatrixWorld();
	let elements = getDraggedElements(cube, 'rotate');
	let [low, high] = getLocalBox(cube);
	let center_local = new THREE.Vector3().fromArray(low.map((v, i) => (v + high[i]) / 2));

	beginDrag({
		mode: 'rotate',
		cube,
		face: edge.face,
		axis: edge.edge_axis,
		direction: 1,
		start_point: new THREE.Vector3(),
		normal: new THREE.Vector3(),
		plane: new THREE.Plane(),
		start_mouse: [event.clientX, event.clientY],
		elements,
		start_values: new Map(),
		changed: false,
		value: 0,
		edge,
		center: mesh.localToWorld(center_local),
		rotation_axis: new THREE.Vector3().setComponent(edge.edge_axis, 1).transformDirection(mesh.matrixWorld),
		last_mouse: [event.clientX, event.clientY],
		angle: 0,
	});
	showEdgeHandle(edge);
	setCursor('rotating');
}

/**
 * Distance the mouse has dragged along the face normal, in world units
 */
function getNormalDistance(event: PointerEvent, preview: Preview): number | null {
	let {start_point, normal} = drag;
	let ray = getRay(preview, event);

	if (Math.abs(ray.direction.dot(normal)) > 0.96) {
		// Looking straight at the face, so the drag line has no screen length. Use vertical mouse movement instead
		let up = new THREE.Vector3(0, 1, 0).applyQuaternion(preview.camera.quaternion);
		let pixels_per_unit = Math.max(toScreen(preview, start_point).distanceTo(toScreen(preview, start_point.clone().add(up))), 0.001);
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

/**
 * Rotate the dragged cubes by an angle around the world space rotation axis through the center of the grabbed cube.
 * Each cube turns rigidly around that center, and its pivot travels along.
 */
function applyRotation(angle: number) {
	let {center, rotation_axis} = drag;
	let radians = Math.degToRad(angle);
	for (let element of drag.elements) {
		let el = element as Cube;
		let start = drag.start_values.get(el);
		let parent = el.mesh.parent;
		parent.updateMatrixWorld();

		// Express the axis and center in the space that the cube's values are in
		let parent_rotation = parent.getWorldQuaternion(new THREE.Quaternion());
		let axis = rotation_axis.clone().applyQuaternion(parent_rotation.invert()).normalize();
		let parent_origin = el.parent instanceof Group ? el.parent.origin : [0, 0, 0];
		let pivot = parent.worldToLocal(center.clone()).add(new THREE.Vector3().fromArray(parent_origin));
		let turn = new THREE.Quaternion().setFromAxisAngle(axis, radians);

		let order = el.mesh.rotation.order;
		let start_rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(
			Math.degToRad(start.rotation[0]), Math.degToRad(start.rotation[1]), Math.degToRad(start.rotation[2]), order
		));
		let euler = new THREE.Euler().setFromQuaternion(turn.clone().multiply(start_rotation), order);
		el.rotation.replace([euler.x, euler.y, euler.z].map(r => Math.roundTo(Math.radToDeg(r), 4)));

		let start_origin = new THREE.Vector3().fromArray(start.origin);
		let origin = start_origin.clone().sub(pivot).applyQuaternion(turn).add(pivot);
		let offset = origin.clone().sub(start_origin).toArray();
		el.origin.replace(origin.toArray().map(v => Math.roundTo(v, 4)));
		el.from.replace(start.from.map((v, i) => Math.roundTo(v + offset[i], 4)));
		el.to.replace(start.to.map((v, i) => Math.roundTo(v + offset[i], 4)));
	}
}

function onRotateMove(event: PointerEvent, preview: Preview): boolean {
	let {edge, center, rotation_axis} = drag;
	let mouse_delta = new THREE.Vector2(event.clientX - drag.last_mouse[0], event.clientY - drag.last_mouse[1]);
	drag.last_mouse = [event.clientX, event.clientY];

	// Find which way the middle of the edge moves on screen when turning, so the edge follows the mouse
	let mesh = edge.cube.mesh;
	mesh.updateMatrixWorld();
	let middle = mesh.localToWorld(edge.ends[0].clone().add(edge.ends[1]).multiplyScalar(0.5));
	let tangent = rotation_axis.clone().cross(middle.clone().sub(center));
	let step = 0.01;
	let screen_tangent = toScreen(preview, middle.clone().addScaledVector(tangent, step)).sub(toScreen(preview, middle)).divideScalar(step);
	// When the edge moves towards the camera it barely moves on screen, so limit how fast it can turn
	let length_sq = Math.max(screen_tangent.lengthSq(), 400);
	drag.angle += Math.radToDeg(mouse_delta.dot(screen_tangent) / length_sq);

	let snap = getRotationInterval(event);
	let angle = Math.round(drag.angle / snap) * snap;
	if (angle == drag.value && drag.changed) return false;
	drag.value = angle;
	drag.changed = true;
	applyRotation(angle);
	Blockbench.setCursorTooltip(trimFloatNumber(angle) + '°');
	return true;
}

function onResizeMove(event: PointerEvent, preview: Preview, snap: number): boolean {
	let {cube, axis, direction, start_point} = drag;
	let mesh = cube.mesh;
	let distance = getNormalDistance(event, preview);
	if (distance == null) return false;
	// Convert the world distance into the cube's own units
	let local_start = mesh.worldToLocal(start_point.clone());
	let local_end = mesh.worldToLocal(start_point.clone().addScaledVector(drag.normal, distance));
	let value = (local_end.getComponent(axis) - local_start.getComponent(axis)) * direction;
	value = Math.round(value / snap) * snap;
	if (value == drag.value && drag.changed) return false;
	drag.value = value;
	drag.changed = true;

	for (let element of drag.elements) {
		let el = element as Cube;
		restoreStartValues(el, drag.start_values.get(el));
		// resize() takes the offset along the axis, so faces on the negative side grow with a negative value
		el.resize(value * direction, axis, direction == -1);
	}
	Blockbench.setCursorTooltip(trimFloatNumber(value));
	return true;
}

function onMoveMove(event: PointerEvent, preview: Preview, snap: number): boolean {
	let {cube, axis, direction, start_point} = drag;
	let mesh = cube.mesh;
	let local: THREE.Vector3;

	if (drag.mode == 'move_normal') {
		// Move along the face normal
		let distance = getNormalDistance(event, preview);
		if (distance == null) return false;
		local = mesh.worldToLocal(start_point.clone().addScaledVector(drag.normal, distance)).sub(mesh.worldToLocal(start_point.clone()));
		let value = Math.round(local.getComponent(axis) / snap) * snap;
		local.set(0, 0, 0).setComponent(axis, value);
	} else {
		// Move along the face plane
		let ray = getRay(preview, event);
		// The face plane is seen edge-on, so the intersection would shoot off into the distance
		if (Math.abs(ray.direction.dot(drag.normal)) < 0.05) return false;
		let point = ray.intersectPlane(drag.plane, new THREE.Vector3());
		if (!point) return false;
		// Snap the offset along the cube's own axes within the face plane
		local = mesh.worldToLocal(point.clone()).sub(mesh.worldToLocal(start_point.clone()));
		local.setComponent(axis, 0);
		for (let i = 0; i < 3; i++) {
			local.setComponent(i, Math.round(local.getComponent(i) / snap) * snap);
		}
	}
	let value = local.x * 1e6 + local.y * 1e3 + local.z;
	if (value == drag.value && drag.changed) return false;
	drag.value = value;
	drag.changed = true;

	let world_offset = mesh.localToWorld(local.clone()).sub(mesh.localToWorld(new THREE.Vector3()));
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
	if (drag.mode == 'move_normal') {
		Blockbench.setCursorTooltip(trimFloatNumber(local.getComponent(axis) * direction));
	} else {
		let parts = [0, 1, 2].filter(i => i != axis && local.getComponent(i)).map(i => AXIS_LETTERS[i].toUpperCase() + ' ' + trimFloatNumber(local.getComponent(i)));
		Blockbench.setCursorTooltip(parts.join('  ') || '0');
	}
	return true;
}

function onDragMove(event: PointerEvent) {
	if (!drag) return;
	let preview = Preview.selected;
	if (!preview) return;
	let snap = canvasGridSize(false, event.ctrlOrCmd || Pressing.overrides.ctrl);

	let changed: boolean;
	if (drag.mode == 'rotate') {
		changed = onRotateMove(event, preview);
	} else if (drag.mode == 'resize') {
		changed = onResizeMove(event, preview, snap);
	} else {
		changed = onMoveMove(event, preview, snap);
	}
	if (!changed) return;

	for (let el of drag.elements) {
		el.preview_controller.updateTransform(el);
		el.preview_controller.updateGeometry(el);
		if (el instanceof Cube) el.preview_controller.updateUV(el);
	}
	updateSelection();
	if (drag.mode == 'rotate') {
		showEdgeHandle(drag.edge);
	} else {
		showHighlight(drag.cube, drag.face);
	}
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
		Undo.finishEdit({
			move: 'Move along cube face',
			move_normal: 'Move along face normal',
			resize: 'Resize cube face',
			rotate: 'Rotate cube by edge',
		}[mode]);
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
			let edge = findEdge(data);
			if (edge) {
				startRotate(edge, event);
			} else {
				startFaceDrag(data);
			}
		},
		onCanvasMouseMove(data) {
			if (drag) return;
			if (data && data.type == 'element' && data.element instanceof Cube && FACE_AXES[data.face] && !data.element.locked) {
				let edge = findEdge(data);
				if (edge) {
					showEdgeHandle(edge);
					setCursor('rotate');
				} else {
					showHighlight(data.element, data.face);
					setCursor(getFaceMode(data.event as MouseEvent));
				}
			} else {
				removeHighlight();
				setCursor(null);
			}
		},
		onSelect() {
			Interface.addSuggestedModifierKey('shift', 'modifier_actions.push_pull_face');
			Interface.addSuggestedModifierKey('alt', 'modifier_actions.move_along_normal');
			Interface.addSuggestedModifierKey('ctrl', 'modifier_actions.reduced_intensity');
		},
		onUnselect() {
			finishDrag(true);
			removeHighlight();
			setCursor(null);
			Interface.removeSuggestedModifierKey('shift', 'modifier_actions.push_pull_face');
			Interface.removeSuggestedModifierKey('alt', 'modifier_actions.move_along_normal');
			Interface.removeSuggestedModifierKey('ctrl', 'modifier_actions.reduced_intensity');
		}
	})
})
