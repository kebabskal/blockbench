/**
 * Scale and rotate the selection as one object around the selection center, instead of each element around its own origin.
 * Elements without a size or rotation, like null objects, only change their position.
 */

type ElementState = {
	element: OutlinerElement
	world_origin: THREE.Vector3
	world_quaternion: THREE.Quaternion
	parent_inverse: THREE.Matrix4
	parent_quaternion_inverse: THREE.Quaternion
	parent_offset: THREE.Vector3
	origin: ArrayVector3
	from?: ArrayVector3
	to?: ArrayVector3
	rotation?: ArrayVector3
	vertices?: Record<string, ArrayVector3>
}
type GroupState = {
	group: Group
	world_origin: THREE.Vector3
	parent_inverse: THREE.Matrix4
	parent_offset: THREE.Vector3
}
type TransformState = {
	elements: ElementState[]
	groups: GroupState[]
	box: THREE.Box3
	pivot: THREE.Vector3
}

let state: TransformState | null = null;

function getRoots(): OutlinerElement[] {
	// Children of selected elements follow their parent
	return Outliner.selected.filter(element => {
		if (!element.getTypeBehavior('movable') || !element.mesh) return false;
		let parent = element.parent;
		while (parent instanceof OutlinerElement) {
			if (parent.selected && !parent.getTypeBehavior('use_absolute_position')) return false;
			parent = parent.parent;
		}
		return true;
	})
}
function getElementOrigin(element: OutlinerElement): ArrayVector3 | undefined {
	return ('origin' in element && element.origin instanceof Array) ? element.origin as ArrayVector3 : undefined;
}
function getParentOffset(node: OutlinerNode): THREE.Vector3 {
	let parent = node.parent;
	if (parent instanceof OutlinerNode && 'origin' in parent && parent.origin instanceof Array) {
		return new THREE.Vector3().fromArray(parent.origin as ArrayVector3);
	}
	return new THREE.Vector3();
}
function canRotate(element: OutlinerElement): boolean {
	if (!element.getTypeBehavior('rotatable') || !('rotation' in element) || !(element.rotation instanceof Array)) return false;
	return element instanceof Cube == false || Format.rotate_cubes;
}

/**
 * Whether the current tool transforms the selection as a whole
 */
export function isGroupTransform(): boolean {
	if (!Modes.edit) return false;
	let tool_id = Toolbox.selected?.id;
	if (tool_id != 'resize_tool' && tool_id != 'rotate_tool') return false;
	let roots = getRoots();
	if (!roots.length) return false;
	// Mesh components are transformed around their own center already
	if (BarItems.selection_mode?.value != 'object' && Mesh.selected.some(mesh => mesh.getSelectedVertices().length)) return false;
	if (tool_id == 'rotate_tool') {
		if (Format.rotation_limit) return false;
		if (Format.bone_rig && Group.first_selected) return false;
	}
	if ((BarItems.transform_pivot_point as BarSelect).value == 'selection_center') return true;
	// Selections the tool can't change one by one, like null objects, are always transformed as a whole
	if (tool_id == 'resize_tool') return !roots.some(element => element.getTypeBehavior('resizable'));
	return !roots.some(canRotate);
}

/**
 * World space bounding box of the selected elements, or their positions where they have no shape
 */
export function getSelectionWorldBox(): THREE.Box3 {
	let box = new THREE.Box3();
	let point = new THREE.Vector3();
	for (let element of getRoots()) {
		let mesh = element.mesh as THREE.Object3D;
		mesh.updateWorldMatrix(true, false);
		if (element instanceof Mesh) {
			for (let key in element.vertices) {
				box.expandByPoint(mesh.localToWorld(point.fromArray(element.vertices[key])));
			}
		} else if (element instanceof Cube) {
			for (let corner = 0; corner < 8; corner++) {
				point.set(
					(corner & 1 ? element.to : element.from)[0] - element.origin[0],
					(corner & 2 ? element.to : element.from)[1] - element.origin[1],
					(corner & 4 ? element.to : element.from)[2] - element.origin[2],
				);
				box.expandByPoint(mesh.localToWorld(point));
			}
		} else {
			box.expandByPoint(mesh.getWorldPosition(point));
		}
	}
	return box;
}

/**
 * Pivot of the transformation in world space. Stays where it started while dragging
 */
export function getGroupPivot(): THREE.Vector3 {
	if (state && Transformer.dragging) return state.pivot.clone();
	let box = getSelectionWorldBox();
	return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

export function startGroupTransform() {
	let box = getSelectionWorldBox();
	state = {
		elements: [],
		groups: [],
		box,
		pivot: box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()),
	};
	for (let element of getRoots()) {
		let mesh = element.mesh as THREE.Object3D;
		let origin = getElementOrigin(element);
		if (!origin) continue;
		mesh.updateWorldMatrix(true, false);
		let element_state: ElementState = {
			element,
			world_origin: mesh.getWorldPosition(new THREE.Vector3()),
			world_quaternion: mesh.getWorldQuaternion(new THREE.Quaternion()),
			parent_inverse: mesh.parent.matrixWorld.clone().invert(),
			parent_quaternion_inverse: mesh.parent.getWorldQuaternion(new THREE.Quaternion()).invert(),
			parent_offset: getParentOffset(element),
			origin: origin.slice() as ArrayVector3,
		};
		if (element instanceof Cube) {
			element_state.from = element.from.slice() as ArrayVector3;
			element_state.to = element.to.slice() as ArrayVector3;
		}
		if (canRotate(element)) {
			element_state.rotation = (element as Cube).rotation.slice() as ArrayVector3;
		}
		if (element instanceof Mesh) {
			element_state.vertices = {};
			for (let key in element.vertices) {
				element_state.vertices[key] = element.vertices[key].slice() as ArrayVector3;
			}
		}
		state.elements.push(element_state);
	}
	if (Format.bone_rig && Toolbox.selected.id == 'resize_tool') {
		for (let group of Group.multi_selected) {
			group.mesh.updateWorldMatrix(true, false);
			state.groups.push({
				group,
				world_origin: group.mesh.getWorldPosition(new THREE.Vector3()),
				parent_inverse: group.mesh.parent.matrixWorld.clone().invert(),
				parent_offset: getParentOffset(group),
			});
		}
	}
}

function toOriginCoordinates(world: THREE.Vector3, parent_inverse: THREE.Matrix4, parent_offset: THREE.Vector3): ArrayVector3 {
	return world.clone().applyMatrix4(parent_inverse).add(parent_offset).toArray() as ArrayVector3;
}
function setOrigin(item: ElementState, origin: ArrayVector3) {
	let target = getElementOrigin(item.element);
	target.V3_set(origin);
	// Cubes store their corners in the same space as their pivot
	if (item.element instanceof Cube && item.from) {
		let offset = origin.slice().V3_subtract(item.origin);
		item.element.from.V3_set(item.from.slice().V3_add(offset));
		item.element.to.V3_set(item.to.slice().V3_add(offset));
	}
}
function updateView() {
	if (!state) return;
	Canvas.updateView({
		elements: state.elements.map(item => item.element),
		element_aspects: {transform: true, geometry: true},
		groups: state.groups.map(item => item.group),
		group_aspects: {transform: true},
		selection: true,
	});
}

/**
 * Size of the selection along each world axis when the transformation started
 */
export function getGroupSize(): THREE.Vector3 {
	let box = state?.box ?? getSelectionWorldBox();
	return box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
}

/**
 * Scale the selection by a factor per world axis around an anchor in world space
 */
export function applyGroupScale(factor: THREE.Vector3, anchor: THREE.Vector3) {
	if (!state) return;
	let vec = new THREE.Vector3();
	let local_factor = new THREE.Vector3();
	for (let item of state.elements) {
		let element = item.element;
		let world_origin = vec.copy(item.world_origin).sub(anchor).multiply(factor).add(anchor);
		let origin = toOriginCoordinates(world_origin, item.parent_inverse, item.parent_offset);

		if (element instanceof Mesh && item.vertices) {
			// Vertices are relative to the origin, so scale their world offset and turn it back
			let inverse = item.world_quaternion.clone().invert();
			for (let key in item.vertices) {
				vec.fromArray(item.vertices[key]).applyQuaternion(item.world_quaternion).multiply(factor).applyQuaternion(inverse);
				element.vertices[key].V3_set(vec.x, vec.y, vec.z);
			}
			getElementOrigin(element).V3_set(origin);

		} else if (element instanceof Cube && item.from) {
			// Cubes can only scale along their own axes, so use how far each of them is scaled
			for (let axis = 0; axis < 3; axis++) {
				vec.set(0, 0, 0).setComponent(axis, 1).applyQuaternion(item.world_quaternion).multiply(factor);
				local_factor.setComponent(axis, vec.length());
			}
			let factors = local_factor.toArray();
			element.origin.V3_set(origin);
			for (let axis = 0; axis < 3; axis++) {
				element.from[axis] = origin[axis] + (item.from[axis] - item.origin[axis]) * factors[axis];
				element.to[axis] = origin[axis] + (item.to[axis] - item.origin[axis]) * factors[axis];
			}
			if (element.box_uv) element.preview_controller.updateUV(element);

		} else {
			setOrigin(item, origin);
		}
	}
	for (let item of state.groups) {
		let world_origin = vec.copy(item.world_origin).sub(anchor).multiply(factor).add(anchor);
		item.group.origin.V3_set(toOriginCoordinates(world_origin, item.parent_inverse, item.parent_offset));
	}
	updateView();
}

/**
 * Rotate the selection around a world space axis through the pivot
 */
export function applyGroupRotation(axis: THREE.Vector3, degrees: number) {
	if (!state) return;
	let rotation = new THREE.Quaternion().setFromAxisAngle(axis, Math.degToRad(degrees));
	let vec = new THREE.Vector3();
	let quaternion = new THREE.Quaternion();
	let euler = new THREE.Euler();
	for (let item of state.elements) {
		let world_origin = vec.copy(item.world_origin).sub(state.pivot).applyQuaternion(rotation).add(state.pivot);
		setOrigin(item, toOriginCoordinates(world_origin, item.parent_inverse, item.parent_offset));

		if (item.rotation) {
			quaternion.copy(rotation).multiply(item.world_quaternion).premultiply(item.parent_quaternion_inverse);
			euler.setFromQuaternion(quaternion, (item.element.mesh as THREE.Object3D).rotation.order);
			(item.element as Cube).rotation.V3_set(
				Math.trimDeg(Math.radToDeg(euler.x)),
				Math.trimDeg(Math.radToDeg(euler.y)),
				Math.trimDeg(Math.radToDeg(euler.z)),
			);
		}
	}
	updateView();
}

export function endGroupTransform() {
	state = null;
}
export function isGroupTransformRunning(): boolean {
	return !!state;
}

BARS.defineActions(() => {
	new BarSelect('transform_pivot_point', {
		condition: {modes: ['edit'], tools: ['resize_tool', 'rotate_tool']},
		category: 'transform',
		value: 'individual_origins',
		options: {
			individual_origins: {name: true, icon: 'scatter_plot'},
			selection_center: {name: true, icon: 'filter_center_focus'},
		},
		icon_mode: true,
		onChange() {
			updateSelection();
		}
	})
})
