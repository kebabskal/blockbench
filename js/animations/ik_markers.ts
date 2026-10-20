// Makes the null objects that drive inverse kinematics easy to see and grab: IK targets and poles get their own
// icons and colors, draw on top of the model, and guide lines connect them to the chain they control

const IK_TARGET_COLOR = '#ffc23d';
const IK_POLE_COLOR = '#ff8a3d';
const ICON_SCALE = {target: 1.9, pole: 1.5};

type IKRole = 'target' | 'pole' | null;
type IKMarkerMesh = THREE.Sprite & {ik_role?: IKRole};

function createIconTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
	let canvas = document.createElement('canvas');
	canvas.width = canvas.height = 64;
	let ctx = canvas.getContext('2d');
	ctx.strokeStyle = ctx.fillStyle = '#ffffff';
	draw(ctx, 64);
	return new THREE.CanvasTexture(canvas);
}
let icons: {target: THREE.CanvasTexture, pole: THREE.CanvasTexture} | null = null;
function getIcons() {
	if (icons) return icons;
	icons = {
		// Ring with a center dot, like a crosshair the end of the chain reaches for
		target: createIconTexture((ctx, size) => {
			ctx.lineWidth = 6;
			ctx.beginPath();
			ctx.arc(size/2, size/2, size/2 - 6, 0, Math.PI * 2);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(size/2, size/2, 7, 0, Math.PI * 2);
			ctx.fill();
		}),
		// Diamond
		pole: createIconTexture((ctx, size) => {
			ctx.lineWidth = 6;
			ctx.beginPath();
			ctx.moveTo(size/2, 5);
			ctx.lineTo(size - 5, size/2);
			ctx.lineTo(size/2, size - 5);
			ctx.lineTo(5, size/2);
			ctx.closePath();
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(size/2, size/2, 6, 0, Math.PI * 2);
			ctx.fill();
		}),
	};
	return icons;
}

function markersEnabled(): boolean {
	return !!(settings.show_ik_markers?.value && Canvas.show_element_markers && Format?.animation_mode);
}
function getRole(null_object: NullObject, pole_uuids: Set<string>): IKRole {
	if (!markersEnabled()) return null;
	if (null_object.ik_target && OutlinerNode.uuids[null_object.ik_target]) return 'target';
	if (pole_uuids.has(null_object.uuid)) return 'pole';
	return null;
}
function getPoleUUIDs(): Set<string> {
	let uuids = new Set<string>();
	for (let null_object of NullObject.all) {
		let {ik_target, ik_pole} = null_object as any;
		if (ik_target && ik_pole) uuids.add(ik_pole);
	}
	return uuids;
}

let original_map: THREE.Texture | null = null;
function styleMarker(element: NullObject) {
	let mesh = element.mesh as IKMarkerMesh;
	if (!mesh?.material) return;
	let material = mesh.material as THREE.SpriteMaterial;
	if (!original_map && material.map && !Object.values(getIcons()).includes(material.map as THREE.CanvasTexture)) {
		original_map = material.map;
	}
	let role = mesh.ik_role;
	let map = role ? getIcons()[role] : original_map;
	if (map && material.map !== map) {
		material.map = map;
		material.needsUpdate = true;
	}
	if (!role) return;
	if (!element.selected) material.color.set(role == 'target' ? IK_TARGET_COLOR : IK_POLE_COLOR);
	// Draw on top of the model, and win clicks against the geometry in front
	material.depthTest = false;
	mesh.renderOrder = 100;
}
function scaleMarker(element: NullObject) {
	let mesh = element.mesh as IKMarkerMesh;
	if (!mesh || !mesh.ik_role) return;
	mesh.scale.multiplyScalar(ICON_SCALE[mesh.ik_role]);
}

// Guide lines
let guides: THREE.Object3D | null = null;
let line_pool: {solid: THREE.Line[], dashed: THREE.Line[]} = {solid: [], dashed: []};
function getGuides(): THREE.Object3D {
	if (guides) return guides;
	guides = new THREE.Object3D();
	guides.name = 'ik_guides';
	// @ts-expect-error
	guides.exclude_from_effects = true;
	guides.no_export = true;
	Canvas.scene.add(guides);
	// @ts-expect-error
	Canvas.ik_guides = guides;
	return guides;
}
function getLine(type: 'solid' | 'dashed', index: number): THREE.Line {
	let pool = line_pool[type];
	if (!pool[index]) {
		let material = type == 'solid'
			? new THREE.LineBasicMaterial({color: IK_TARGET_COLOR, transparent: true, opacity: 1, depthTest: false})
			: new THREE.LineDashedMaterial({color: IK_POLE_COLOR, transparent: true, opacity: 1, depthTest: false, dashSize: 1, gapSize: 1});
		let geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
		let line = new THREE.Line(geometry, material);
		line.renderOrder = 99;
		line.frustumCulled = false;
		line.no_export = true;
		getGuides().add(line);
		pool[index] = line;
	}
	return pool[index];
}
function setLine(line: THREE.Line, start: THREE.Vector3, end: THREE.Vector3) {
	let position = line.geometry.attributes.position as THREE.BufferAttribute;
	position.setXYZ(0, start.x, start.y, start.z);
	position.setXYZ(1, end.x, end.y, end.z);
	position.needsUpdate = true;
	line.geometry.computeBoundingSphere();
	if (line.material instanceof THREE.LineDashedMaterial) {
		// Keep the dashes a similar size on screen
		let preview = Preview.selected;
		if (preview) {
			let middle = start.clone().add(end).multiplyScalar(0.5);
			let scale = preview.calculateControlScale(middle) / 8;
			line.material.dashSize = line.material.gapSize = scale;
		}
		line.computeLineDistances();
	}
	line.visible = true;
}
function getNodeWorldPosition(node: OutlinerNode): THREE.Vector3 | null {
	let object = (node as any).scene_object ?? (node as any).mesh;
	return object ? object.getWorldPosition(new THREE.Vector3()) : null;
}

/**
 * The joint that bends towards the pole, like the knee: the middle of the chain between the IK root and the target
 */
function getBendJoint(null_object: NullObject, target: OutlinerNode): OutlinerNode | null {
	let ik_source = (null_object as any).ik_source as string;
	let source = ik_source ? OutlinerNode.uuids[ik_source] : null_object.parent;
	let chain: OutlinerNode[] = [];
	let current: any = target;
	while (current instanceof OutlinerNode && current !== source) {
		chain.push(current);
		current = current.parent;
	}
	if (current instanceof OutlinerNode && ik_source) chain.push(current);
	chain.reverse();
	if (chain.length < 3) return chain[chain.length - 1] ?? null;
	return chain[Math.floor(chain.length / 2)];
}

function updateIKMarkers() {
	if (typeof NullObject == 'undefined' || !Project) return;
	// Keep each null's icon in sync with its role, which changes when IK settings are edited
	let pole_uuids = getPoleUUIDs();
	for (let null_object of NullObject.all) {
		let mesh = null_object.mesh as IKMarkerMesh;
		if (!mesh) continue;
		let role = getRole(null_object, pole_uuids);
		if (mesh.ik_role !== role) {
			mesh.ik_role = role;
			NullObject.preview_controller.updateSelection(null_object);
			NullObject.preview_controller.updateTransform(null_object);
		}
	}

	let used = {solid: 0, dashed: 0};
	let show = markersEnabled() && (Modes.edit || Modes.animate) && !(Canvas as any).clean_view;
	if (show) {
		for (let null_object of NullObject.all) {
			if (!null_object.ik_target || null_object.visibility === false || !null_object.mesh) continue;
			let target = OutlinerNode.uuids[null_object.ik_target];
			if (!target) continue;
			let goal = null_object.mesh.getWorldPosition(new THREE.Vector3());
			let end = getNodeWorldPosition(target);
			// From the end of the chain to the target. Shows how far off the target is when the chain can't reach it
			if (end) setLine(getLine('solid', used.solid++), end, goal);

			let ik_pole = (null_object as any).ik_pole as string;
			let pole = ik_pole ? OutlinerNode.uuids[ik_pole] : null;
			let joint = pole && getBendJoint(null_object, target);
			let joint_position = joint && getNodeWorldPosition(joint);
			let pole_position = pole && getNodeWorldPosition(pole);
			if (joint_position && pole_position) {
				setLine(getLine('dashed', used.dashed++), joint_position, pole_position);
			}
		}
	}
	for (let type of ['solid', 'dashed'] as const) {
		line_pool[type].forEach((line, i) => {
			if (i >= used[type]) line.visible = false;
		})
	}
}

export function refreshIKMarkers() {
	if (typeof NullObject == 'undefined') return;
	NullObject.all.forEach(null_object => {
		(null_object.mesh as IKMarkerMesh).ik_role = undefined;
	})
	updateIKMarkers();
}

BARS.defineActions(() => {
	NullObject.preview_controller.on('update_selection', ({element}) => styleMarker(element));
	// Icons are resized on transform updates and when the window or field of view changes
	let controller = NullObject.preview_controller as any;
	let updateWindowSize = controller.updateWindowSize;
	controller.updateWindowSize = function(element: NullObject) {
		updateWindowSize.call(this, element);
		scaleMarker(element);
	}
	Blockbench.on('before_render_frame', updateIKMarkers);
})

Object.assign(window, {refreshIKMarkers});
