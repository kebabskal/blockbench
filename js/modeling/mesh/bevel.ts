// Bevel: replaces selected mesh edges with a strip of faces, or selected vertices with a small face.
// Works by walking the ring of faces around every affected vertex and replacing the vertex in each face with new
// vertices, then filling the gaps with strips along the edges and caps at the corners.

type Fan = {
	edges: string[]
	faces: string[]
	closed: boolean
}
type CapData = {polygon: string[], uv: Record<string, ArrayVector2>, template: string, normal: THREE.Vector3, center: string | null}
type EdgeEnd = {left_face: string | null, right_face: string | null, arc: string[]}

const edgeKey = (a: string, b: string) => a < b ? a + ':' + b : b + ':' + a;
function vec(mesh: Mesh, vkey: string) {
	return new THREE.Vector3().fromArray(mesh.vertices[vkey]);
}

function getVertexFaces(mesh: Mesh): Record<string, string[]> {
	let map: Record<string, string[]> = {};
	for (let fkey in mesh.faces) {
		let face = mesh.faces[fkey];
		if (face.vertices.length < 3) continue;
		for (let vkey of face.vertices) {
			(map[vkey] || (map[vkey] = [])).push(fkey);
		}
	}
	return map;
}

/**
 * Faces around a vertex in order, with the edges between them, named by the vertex at their other end.
 * faces[i] lies between edges[i] and edges[i+1]. An open fan has one more edge than faces.
 */
function getFan(mesh: Mesh, vkey: string, face_keys: string[]): Fan | null {
	let neighbors: Record<string, [string, string]> = {};
	let edge_faces: Record<string, string[]> = {};
	for (let fkey of face_keys) {
		let loop = mesh.faces[fkey].getSortedVertices();
		let index = loop.indexOf(vkey);
		let pair: [string, string] = [loop[(index + loop.length - 1) % loop.length], loop[(index + 1) % loop.length]];
		neighbors[fkey] = pair;
		pair.forEach(key => (edge_faces[key] || (edge_faces[key] = [])).push(fkey));
	}
	let start = Object.keys(edge_faces).find(key => edge_faces[key].length == 1) ?? neighbors[face_keys[0]]?.[0];
	if (!start) return null;

	let edges = [start];
	let faces: string[] = [];
	let current = edge_faces[start][0];
	while (current) {
		faces.push(current);
		let pair = neighbors[current];
		let exit = pair[0] == edges.last() ? pair[1] : pair[0];
		edges.push(exit);
		current = edge_faces[exit].find(fkey => !faces.includes(fkey));
	}
	let closed = edges.length > 2 && edges.last() == edges[0];
	if (closed) edges.pop();
	return {edges, faces, closed};
}

function rotateFan(fan: Fan, offset: number) {
	fan.edges = fan.edges.slice(offset).concat(fan.edges.slice(0, offset));
	fan.faces = fan.faces.slice(offset).concat(fan.faces.slice(0, offset));
}

function bevelMesh(mesh: Mesh, width: number, segments: number): string[] {
	let vertex_mode = BarItems.selection_mode.value == 'vertex';
	let beveled_edges: [string, string][] = vertex_mode ? [] : mesh.getSelectedEdges().map(edge => [edge[0], edge[1]]);
	let vertices: string[] = vertex_mode ? mesh.getSelectedVertices().slice() : [];
	if (!vertex_mode) beveled_edges.forEach(edge => vertices.safePush(edge[0], edge[1]));
	if (!vertices.length) return [];

	let beveled = new Set(beveled_edges.map(edge => edgeKey(edge[0], edge[1])));
	let vertex_faces = getVertexFaces(mesh);
	let fans: Record<string, Fan> = {};
	for (let vkey of vertices) {
		if (!vertex_faces[vkey]) continue;
		let fan = getFan(mesh, vkey, vertex_faces[vkey]);
		if (fan) fans[vkey] = fan;
	}

	// Keep new vertices from running past each other on short edges
	for (let vkey in fans) {
		for (let other of fans[vkey].edges) {
			if (beveled.has(edgeKey(vkey, other))) continue;
			width = Math.min(width, vec(mesh, vkey).distanceTo(vec(mesh, other)) * 0.45);
		}
	}

	let cuts: Record<string, string> = {};
	let arcs: Record<string, string[]> = {};
	// New vertices of a face corner, ordered from the fan's entry edge to its exit edge
	let corners: Record<string, Record<string, string[]>> = {};
	let ends: Record<string, Record<string, EdgeEnd>> = {};
	let cap_polygons: {vkey: string, polygon: string[], fan: Fan}[] = [];

	let setCorner = (fkey: string, vkey: string, list: string[]) => {
		(corners[fkey] || (corners[fkey] = {}))[vkey] = list;
	}
	let cut = (vkey: string, other: string) => {
		let key = vkey + '>' + other;
		if (!cuts[key]) {
			let position = vec(mesh, vkey).lerp(vec(mesh, other), width / vec(mesh, vkey).distanceTo(vec(mesh, other)));
			cuts[key] = mesh.addVertices(position.toArray())[0];
		}
		return cuts[key];
	}
	// Rounded connection between two new vertices, curving towards the original corner
	let arc = (vkey: string, a: string, b: string) => {
		if (segments < 2 || a == vkey || b == vkey) return [a, b];
		let key = edgeKey(a, b);
		if (!arcs[key]) {
			let [start, end, control] = [vec(mesh, a), vec(mesh, b), vec(mesh, vkey)];
			let inner = [];
			for (let i = 1; i < segments; i++) {
				let t = i / segments;
				inner.push(new THREE.Vector3()
					.addScaledVector(start, (1 - t) * (1 - t))
					.addScaledVector(control, 2 * t * (1 - t))
					.addScaledVector(end, t * t)
					.toArray());
			}
			arcs[key] = [a, ...mesh.addVertices(...inner), b];
		}
		return arcs[key][0] == a ? arcs[key] : arcs[key].slice().reverse();
	}
	let addEnd = (vkey: string, other: string, left_face: string | null, right_face: string | null, arc_keys: string[]) => {
		let key = edgeKey(vkey, other);
		(ends[key] || (ends[key] = {}))[vkey] = {left_face, right_face, arc: arc_keys};
	}

	for (let vkey in fans) {
		let fan = fans[vkey];
		let {closed} = fan;
		if (vertex_mode) {
			let ring = fan.edges.map(other => cut(vkey, other));
			fan.faces.forEach((fkey, i) => {
				setCorner(fkey, vkey, [ring[i], ring[(i + 1) % ring.length]]);
			})
			if (ring.length >= 3) cap_polygons.push({vkey, polygon: ring, fan});
			continue;
		}

		let first = fan.edges.findIndex(other => beveled.has(edgeKey(vkey, other)));
		if (first == -1) continue;
		if (closed) rotateFan(fan, first);
		let {edges, faces} = fan;
		let indices = edges.map((other, i) => beveled.has(edgeKey(vkey, other)) ? i : -1).filter(i => i != -1);

		if (closed && indices.length == 1) {
			// A single beveled edge ends here: it splits into the two neighboring edges
			if (faces.length < 3) continue;
			let a = cut(vkey, edges[1]);
			let b = cut(vkey, edges[edges.length - 1]);
			let keys = arc(vkey, a, b);
			addEnd(vkey, edges[0], faces[faces.length - 1], faces[0], keys.slice().reverse());
			setCorner(faces[0], vkey, [a]);
			setCorner(faces[faces.length - 1], vkey, [b]);
			if (faces.length == 3) {
				setCorner(faces[1], vkey, keys);
			} else {
				// The other edges stay on the original vertex, which keeps a triangle next to the strip
				setCorner(faces[1], vkey, [a, vkey]);
				setCorner(faces[faces.length - 2], vkey, [vkey, b]);
				cap_polygons.push({vkey, polygon: [...keys, vkey], fan});
			}
			continue;
		}

		// Between two beveled edges, all faces share one new vertex
		let sectorVertex = (start: number, end: number) => {
			let inner = [];
			for (let i = start + 1; i < end; i++) inner.push(edges[i % edges.length]);
			if (inner.length) return cut(vkey, inner[Math.floor(inner.length / 2)]);
			if (start < 0 || end >= edges.length + (closed ? 1 : 0)) return vkey;
			let center = vec(mesh, vkey);
			let dir_a = vec(mesh, edges[start]).sub(center).normalize();
			let dir_b = vec(mesh, edges[end % edges.length]).sub(center).normalize();
			let sine = Math.max(dir_a.clone().cross(dir_b).length(), 0.2);
			return mesh.addVertices(center.clone().addScaledVector(dir_a.add(dir_b), width / sine).toArray())[0];
		}
		let chain: string[] = [];
		let sector_vertices: string[] = [];
		let boundaries = closed ? [...indices, indices[0] + edges.length] : indices;
		if (!closed) {
			// Open fans also have the sectors towards their ends
			let leading = indices[0] > 0 ? sectorVertex(-1, indices[0]) : vkey;
			sector_vertices.push(leading);
			for (let f = 0; f < indices[0]; f++) setCorner(faces[f], vkey, [leading]);
		}
		for (let i = 0; i < boundaries.length - 1; i++) {
			let start = boundaries[i], end = boundaries[i + 1];
			let sector = sectorVertex(start, end);
			sector_vertices.push(sector);
			for (let f = start; f < end; f++) setCorner(faces[f % faces.length], vkey, [sector]);
		}
		if (!closed) {
			let last = indices[indices.length - 1];
			let trailing = last < edges.length - 1 ? sectorVertex(last, edges.length) : vkey;
			sector_vertices.push(trailing);
			for (let f = last; f < faces.length; f++) setCorner(faces[f], vkey, [trailing]);
		}
		indices.forEach((edge_index, i) => {
			let left = closed ? sector_vertices[(i + sector_vertices.length - 1) % sector_vertices.length] : sector_vertices[i];
			let right = closed ? sector_vertices[i] : sector_vertices[i + 1];
			let left_face = closed ? faces[(edge_index + faces.length - 1) % faces.length] : (faces[edge_index - 1] ?? null);
			let right_face = faces[edge_index] ?? null;
			let keys = arc(vkey, left, right);
			addEnd(vkey, edges[edge_index], left_face, right_face, keys);
			chain.push(...keys.slice(chain.length ? 1 : 0));
		})
		if (closed) chain.pop();
		chain = chain.filter((key, i) => key != chain[i - 1]);
		// With two edges passing through, their strips meet directly
		if (closed ? indices.length >= 3 : chain.length >= 3) cap_polygons.push({vkey, polygon: chain, fan});
	}

	// Work out everything that needs the original faces before changing them
	let original_uv: Record<string, Record<string, ArrayVector2>> = {};
	let original_normals: Record<string, THREE.Vector3> = {};
	let rebuilt: Record<string, {polygon: string[], uv: Record<string, ArrayVector2>}> = {};
	let toUV = (fkey: string, vkey: string): ArrayVector2 => {
		let face = mesh.faces[fkey];
		if (face.uv[vkey]) return face.uv[vkey].slice() as ArrayVector2;
		return face.localToUV(vec(mesh, vkey)) as ArrayVector2;
	}
	let getNormal = (fkey: string) => new THREE.Vector3().fromArray(mesh.faces[fkey].getNormal(true));

	for (let fkey in mesh.faces) {
		if (mesh.faces[fkey].vertices.length >= 3) original_normals[fkey] = getNormal(fkey);
	}
	for (let fkey in corners) {
		let face = mesh.faces[fkey];
		original_uv[fkey] = {...face.uv};
		let loop = face.getSortedVertices();
		let polygon: string[] = [];
		loop.forEach((vkey, i) => {
			let list = corners[fkey][vkey];
			if (!list) {
				polygon.push(vkey);
				return;
			}
			let fan = fans[vkey];
			let fan_index = fan.faces.indexOf(fkey);
			let previous = loop[(i + loop.length - 1) % loop.length];
			polygon.push(...(fan.edges[fan_index] == previous ? list : list.slice().reverse()));
		})
		polygon = polygon.filter((vkey, i) => vkey != polygon[(i + polygon.length - 1) % polygon.length]);
		let uv: Record<string, ArrayVector2> = {};
		polygon.forEach(vkey => uv[vkey] = toUV(fkey, vkey));
		rebuilt[fkey] = {polygon, uv};
	}
	let caps: CapData[] = cap_polygons.map(({vkey, polygon, fan}) => {
		let normal = new THREE.Vector3();
		fan.faces.forEach(fkey => normal.add(original_normals[fkey]));
		let template = fan.faces[0];
		// Rounded caps are concave, and quads get their corners sorted by shape, which would scramble them.
		// They are fanned out from a point that sees the whole ring instead
		let center: string | null = null;
		if (segments > 1 && polygon.length > 3) {
			if (polygon.includes(vkey)) {
				center = vkey;
			} else {
				let middle = new THREE.Vector3();
				polygon.forEach(key => middle.add(vec(mesh, key)));
				middle.divideScalar(polygon.length).lerp(vec(mesh, vkey), 0.4);
				center = mesh.addVertices(middle.toArray())[0];
			}
		}
		let uv: Record<string, ArrayVector2> = {};
		[...polygon, ...(center ? [center] : [])].forEach(key => uv[key] = toUV(template, key));
		return {polygon, uv, template, normal, center};
	})

	// Faces only have up to four sides, so larger polygons are split up
	let new_faces: string[] = [];
	let splitPolygon = (polygon: string[]) => {
		if (polygon.length <= 4) return [polygon];
		let parts = [];
		let anchor = polygon[0];
		let i = 1;
		while (i < polygon.length - 1) {
			let remaining = polygon.length - i;
			let part = remaining >= 3 ? [anchor, polygon[i], polygon[i + 1], polygon[i + 2]] : [anchor, polygon[i], polygon[i + 1]];
			parts.push(part);
			i += part.length - 2;
		}
		return parts;
	}
	let orient = (fkey: string, normal: THREE.Vector3) => {
		if (normal.lengthSq() > 1e-9 && getNormal(fkey).dot(normal) < 0) mesh.faces[fkey].invert();
	}
	let pick = (uv: Record<string, ArrayVector2>, keys: string[]) => {
		let result: Record<string, ArrayVector2> = {};
		keys.forEach(key => result[key] = uv[key]);
		return result;
	}
	let addFace = (template: string, polygon: string[], uv: Record<string, ArrayVector2>, normal: THREE.Vector3) => {
		let face = new MeshFace(mesh, mesh.faces[template]).extend({vertices: polygon, uv: pick(uv, polygon)});
		let [fkey] = mesh.addFaces(face);
		orient(fkey, normal);
		return fkey;
	}

	for (let fkey in rebuilt) {
		let {polygon, uv} = rebuilt[fkey];
		let face = mesh.faces[fkey];
		let [first, ...others] = splitPolygon(polygon);
		face.vertices.splice(0, Infinity, ...first);
		for (let key in face.uv) delete face.uv[key];
		Object.assign(face.uv, pick(uv, first));
		orient(fkey, original_normals[fkey]);
		others.forEach(part => addFace(fkey, part, uv, original_normals[fkey]));
	}

	// Strips along the beveled edges, showing the part of the neighboring face that was cut off
	for (let edge of beveled_edges) {
		let [a, b] = edge;
		let end_a = ends[edgeKey(a, b)]?.[a];
		let end_b = ends[edgeKey(a, b)]?.[b];
		if (!end_a || !end_b) continue;
		let arc_a = end_a.arc;
		let arc_b = end_a.left_face == end_b.left_face ? end_b.arc : end_b.arc.slice().reverse();
		if (arc_a.length != arc_b.length) {
			arc_a = [arc_a[0], arc_a.last()];
			arc_b = [arc_b[0], arc_b.last()];
		}
		let from_left = !!end_a.left_face;
		let template = end_a.left_face ?? end_a.right_face;
		if (!template) continue;
		let normal = new THREE.Vector3();
		[end_a.left_face, end_a.right_face].forEach(fkey => fkey && normal.add(original_normals[fkey]));
		let getUV = (vkey: string, original: string, arc_keys: string[], index: number): ArrayVector2 => {
			let start = from_left ? arc_keys[0] : arc_keys.last();
			let blend = (from_left ? index : arc_keys.length - 1 - index) / (arc_keys.length - 1);
			let uv_start = rebuilt[template]?.uv[start] ?? original_uv[template]?.[original] ?? [0, 0];
			let uv_end = original_uv[template]?.[original] ?? uv_start;
			return [Math.lerp(uv_start[0], uv_end[0], blend), Math.lerp(uv_start[1], uv_end[1], blend)];
		}
		for (let i = 0; i < arc_a.length - 1; i++) {
			let polygon = [arc_a[i], arc_a[i + 1], arc_b[i + 1], arc_b[i]].filter((key, index, list) => list.indexOf(key) == index);
			if (polygon.length < 3) continue;
			let uv: Record<string, ArrayVector2> = {
				[arc_a[i]]: getUV(arc_a[i], a, arc_a, i),
				[arc_a[i + 1]]: getUV(arc_a[i + 1], a, arc_a, i + 1),
				[arc_b[i]]: getUV(arc_b[i], b, arc_b, i),
				[arc_b[i + 1]]: getUV(arc_b[i + 1], b, arc_b, i + 1),
			};
			new_faces.push(addFace(template, polygon, uv, normal));
		}
	}
	for (let cap of caps) {
		let {polygon, center} = cap;
		let parts = splitPolygon(polygon);
		if (center) {
			let ring = polygon.filter(key => key != center);
			let closed_ring = polygon.includes(center) ? ring : [...ring, ring[0]];
			parts = [];
			for (let i = 0; i < closed_ring.length - 1; i++) parts.push([center, closed_ring[i], closed_ring[i + 1]]);
		}
		parts.forEach(part => {
			new_faces.push(addFace(cap.template, part, cap.uv, cap.normal));
		})
	}

	// Remove the original vertices that nothing uses anymore
	let used = new Set<string>();
	for (let fkey in mesh.faces) mesh.faces[fkey].vertices.forEach(vkey => used.add(vkey));
	for (let vkey of vertices) {
		if (!used.has(vkey)) delete mesh.vertices[vkey];
	}
	return new_faces;
}

BARS.defineActions(() => {
	new Action('bevel_mesh_selection', {
		icon: 'change_history',
		category: 'edit',
		keybind: new Keybind({key: 'b', alt: true}),
		condition: {modes: ['edit'], features: ['meshes'], method: () => {
			let mesh = Mesh.selected[0];
			if (!mesh) return false;
			return BarItems.selection_mode.value == 'vertex' ? mesh.getSelectedVertices().length > 0 : mesh.getSelectedEdges().length > 0;
		}},
		click() {
			let vertex_mode = BarItems.selection_mode.value == 'vertex';
			function runEdit(amended: boolean, width = 1, segments = 1) {
				Undo.initEdit({elements: Mesh.selected, selection: true}, amended);
				Mesh.selected.forEach(mesh => {
					let new_faces = bevelMesh(mesh, width, Math.round(segments));
					if (!new_faces.length) return;
					let vertices = [];
					new_faces.forEach(fkey => vertices.safePush(...mesh.faces[fkey].vertices));
					mesh.getSelectedEdges(true).empty();
					mesh.getSelectedVertices(true).replace(vertices);
					mesh.getSelectedFaces(true).replace(new_faces);
				})
				Undo.finishEdit('Bevel mesh selection');
				Canvas.updateView({elements: Mesh.selected, element_aspects: {geometry: true, uv: true, faces: true}, selection: true});
			}
			runEdit(false);
			Undo.amendEdit({
				width: {type: 'num_slider', value: 1, label: 'edit.bevel.width', min: 0, interval_type: 'position'},
				segments: {type: 'num_slider', value: 1, label: 'edit.bevel.segments', min: 1, max: 16, step: 1, condition: !vertex_mode},
			}, form => {
				runEdit(true, form.width, form.segments);
			})
		}
	})
})

declare global {
	interface BarItemRegistry {
		bevel_mesh_selection: Action
	}
}

export {};
