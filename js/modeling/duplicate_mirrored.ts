// Duplicate Mirrored: duplicate the selected elements and flip the copies across the X center line of
// their parent group, so building one side of something symmetrical (a fin, an arm) gives you the
// other side in one step. The center line goes through the parent group's pivot, or the model's
// center for elements at the root. UVs are mirrored along with the shape, like Flip does it.

function getMirrorCenter(element: OutlinerElement): number {
	if (element.parent instanceof Group) return element.parent.origin[0];
	return Format.centered_grid ? 0 : 8;
}

function flipAcross(element: OutlinerElement, center: number) {
	if (element instanceof Mesh) {
		// Mesh.flip mirrors around 0, so move its pivot over to the other side of the center line after
		element.flip(0);
		element.origin[0] += center * 2;
		element.preview_controller.updateTransform(element);
	} else if ('flip' in element && typeof element.flip == 'function') {
		element.flip(0, center, false);
	}
}

export function duplicateMirrored() {
	let originals = Outliner.selected.filter(element => {
		if (element.getTypeBehavior('duplicatable') == false) return false;
		// Children of selected elements come along with their parent
		if (element.parent instanceof OutlinerElement && element.parent.selected) return false;
		return true;
	});
	if (!originals.length) return;

	let added_elements: OutlinerElement[] = [];
	Undo.initEdit({elements: added_elements, outliner: true, selection: true});

	Outliner.selected.empty();
	for (let original of originals) {
		let center = getMirrorCenter(original);
		let copy = original.duplicate();
		added_elements.push(copy);
		flipAcross(copy, center);
		if ('forEachChild' in copy) {
			(copy as any).forEachChild((child: OutlinerNode) => {
				if (child instanceof OutlinerElement) {
					added_elements.push(child);
					flipAcross(child, center);
				}
			});
		}
		copy.markAsSelected();
	}

	updateSelection();
	Undo.finishEdit('Duplicate mirrored');
}

BARS.defineActions(function() {
	new Action('duplicate_mirrored', {
		icon: 'flip',
		category: 'edit',
		condition: {modes: ['edit'], project: true, method: () => Outliner.selected.length > 0},
		keybind: new Keybind({key: 'd', ctrl: true, shift: true}),
		click() {
			duplicateMirrored();
		}
	})
})
