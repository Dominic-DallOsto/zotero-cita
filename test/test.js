import SourceItemWrapper from '../src/sourceItemWrapper.js';
// import assert from 'assert';

/* global Zotero */
/* global describe it */

const tests = {
	// Called when the server asks the client to run
	tests: () => {
		// write your tests here or require a package that calls the mocha globals
		describe("SourceItemWrapper", () => {
			it("can wrap a new item - has 0 citations", () => {
				const wrapper = new SourceItemWrapper(new Zotero.Item());
				if (wrapper.citations != 0){
					throw new Error();
				}
			});
		});
	}
}

export default tests;
