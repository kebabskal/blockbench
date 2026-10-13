import { MirrorModeling } from "../modeling/mirror_modeling";

// Mirror UVs to Other Side: UV one side of something symmetrical, then copy those UVs, mirrored,
// onto the other side, so both sides share the same texture.
//
// For each selected cube:
// - If it has a matching cube on the other side of the model (found the same way Mirror Modeling
//   finds them), all its faces are mirrored onto that cube. If the selection is all on one side,
//   that side is the source, otherwise the side the camera is on.
// - Otherwise the face the camera looks at is mirrored onto the opposite face of the same cube.
//   This works in the cube's own rotation, so it also works for single cubes that span both sides
//   of a fish or a fin, wherever they are and however they are rotated.

const OPPOSITE_FACE = {east: 'west', west: 'east', up: 'down', down: 'up', south: 'north', north: 'south'} as const;
const FACE_NORMALS = {
	east: [1, 0, 0], west: [-1, 0, 0],
	up: [0, 1, 0], down: [0, -1, 0],
	south: [0, 0, 1], north: [0, 0, -1],
} as const;
type FaceKey = keyof typeof OPPOSITE_FACE;

function getCenter(): number {
	return Format.centered_grid ? 0 : 8;
}

// Which side of the center line a cube is on: 1, -1, or 0 for centered cubes
function getSide(cube: Cube, center: number): number {
	let middle = (cube.from[0] + cube.to[0]) / 2;
	if (Math.epsilon(middle, center, 0.01)) return 0;
	return Math.sign(middle - center);
}

// Which side of the model the camera looks from, in model space
function getCameraSide(center: number): number {
	let camera = Preview.selected?.camera;
	if (!camera) return 1;
	let model_x = camera.position.x - Canvas.scene.position.x;
	return Math.sign(model_x - center) || 1;
}

// The face of a cube that takes up the most of the view: how much it faces the camera times its
// size, taking the cube's rotation into account. Weighing by size keeps a thin fin's top edge or a
// flat body's top from winning over its big side face when looking from a diagonal.
function getFacingFace(cube: Cube): FaceKey {
	let camera = Preview.selected?.camera;
	let mesh = cube.mesh;
	if (!camera || !mesh) return 'east';

	let to_camera = new THREE.Vector3();
	if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
		camera.getWorldDirection(to_camera).negate();
	} else {
		let center = new THREE.Vector3(
			(cube.from[0] + cube.to[0]) / 2 - cube.origin[0],
			(cube.from[1] + cube.to[1]) / 2 - cube.origin[1],
			(cube.from[2] + cube.to[2]) / 2 - cube.origin[2],
		);
		mesh.localToWorld(center);
		to_camera.copy(camera.position).sub(center);
	}
	to_camera.normalize();
	let rotation = mesh.getWorldQuaternion(new THREE.Quaternion());
	let size = cube.size();
	let area = {
		east: size[1] * size[2], west: size[1] * size[2],
		up: size[0] * size[2], down: size[0] * size[2],
		south: size[0] * size[1], north: size[0] * size[1],
	};

	let best: FaceKey = 'east';
	let best_visible = -Infinity;
	for (let fkey in FACE_NORMALS) {
		let normal = new THREE.Vector3(...FACE_NORMALS[fkey as FaceKey]).applyQuaternion(rotation);
		let visible = normal.dot(to_camera) * Math.max(area[fkey as FaceKey], 0.01);
		if (visible > best_visible) {
			best_visible = visible;
			best = fkey as FaceKey;
		}
	}
	return best;
}

// The UV of a face as it looks when mirrored onto the opposite side, like Cube.flip does it.
// Side faces and up/down faces flip U, up and down onto each other flips V.
// Faces rotated by 90 or 270 flip the other way.
function mirroredUV(face: CubeFace, flip_v: boolean): [number, number, number, number] {
	let uv = face.uv;
	if (face.rotation == 90 || face.rotation == 270) flip_v = !flip_v;
	if (flip_v) {
		return [uv[0], uv[3], uv[2], uv[1]];
	}
	return [uv[2], uv[1], uv[0], uv[3]];
}

function copyFace(source: CubeFace, target: CubeFace, flip_v = false) {
	target.uv = mirroredUV(source, flip_v);
	target.rotation = source.rotation;
	target.texture = source.texture;
}

// Mirror every face of one cube onto its partner on the other side
function mirrorOntoPartner(source: Cube, target: Cube) {
	if (source.box_uv || target.box_uv) {
		target.box_uv = source.box_uv;
		target.uv_offset = source.uv_offset.slice() as ArrayVector2;
		target.mirror_uv = !source.mirror_uv;
		for (let fkey in source.faces) {
			target.faces[fkey].texture = source.faces[fkey].texture;
		}
		return;
	}
	for (let fkey in source.faces) {
		// The partner's east face matches this cube's west face and the other way around
		let target_key = fkey == 'east' ? 'west' : fkey == 'west' ? 'east' : fkey;
		copyFace(source.faces[fkey], target.faces[target_key]);
	}
}

// Mirror the face the camera looks at onto the opposite face of the same cube
function mirrorOntoOppositeFace(cube: Cube) {
	let from_face = getFacingFace(cube);
	let to_face = OPPOSITE_FACE[from_face];
	let flip_v = from_face == 'up' || from_face == 'down';
	copyFace(cube.faces[from_face], cube.faces[to_face], flip_v);
}

export function mirrorUVToOtherSide() {
	let center = getCenter();
	let selected = Cube.selected.filter(cube => !cube.locked);
	if (!selected.length) {
		Blockbench.showQuickMessage('message.mirror_uv_to_other_side.no_selection');
		return;
	}

	// Cubes with a partner: one side selected copies that side, both sides copy the camera's side
	let sides = new Set(selected.map(cube => getSide(cube, center)).filter(side => side != 0));
	let source_side = sides.size == 1 ? [...sides][0] : getCameraSide(center);

	let pairs: {source: Cube, target: Cube}[] = [];
	let singles: Cube[] = [];
	let seen = new Set<Cube>();
	for (let cube of selected) {
		let side = getSide(cube, center);
		let partner = side != 0 && MirrorModeling.getMirrorElement(cube) as Cube | false;
		if (!partner || partner === cube) {
			// Box UV faces can't be set on their own
			if (!cube.box_uv) singles.safePush(cube);
			continue;
		}
		let source = side == source_side ? cube : partner;
		let target = side == source_side ? partner : cube;
		if (seen.has(source)) continue;
		seen.add(source);
		pairs.push({source, target});
	}

	if (!pairs.length && !singles.length) {
		Blockbench.showQuickMessage('message.mirror_uv_to_other_side.nothing');
		return;
	}

	let targets = [...pairs.map(pair => pair.target), ...singles];
	Undo.initEdit({elements: targets, uv_only: true});

	for (let {source, target} of pairs) {
		mirrorOntoPartner(source, target);
	}
	for (let cube of singles) {
		mirrorOntoOppositeFace(cube);
	}

	for (let cube of targets) {
		cube.preview_controller.updateFaces(cube);
		cube.preview_controller.updateUV(cube);
	}
	UVEditor.loadData();
	Undo.finishEdit('Mirror UVs to other side');

	Blockbench.showQuickMessage(tl('message.mirror_uv_to_other_side.done', [targets.length]), 2000);
}

BARS.defineActions(function() {
	new Action('mirror_uv_to_other_side', {
		icon: 'flip',
		category: 'uv',
		condition: {modes: ['edit', 'paint'], project: true, method: () => Cube.selected.length > 0},
		keybind: new Keybind({key: 'm', alt: true}),
		click() {
			mirrorUVToOtherSide();
		}
	})
})
