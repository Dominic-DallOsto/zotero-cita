import Wikicite, { debug } from './wikicite';
import Citation from './citation';
import Progress from './progress';
/* global Services */
/* global Zotero */
/* global window */

export default class Crossref{

    /**
     * Get source item citations from CrossRef.
     * @param {SourceItemWrapper[]} sourceItems - One or more source items to get citations for.
     */
    static async addCrossrefCitationsToItems(sourceItems){

        // Make sure that at least some of the source items have DOIs
        const sourceItemsWithDOI = sourceItems.filter((sourceItem) => sourceItem.getPID('DOI'));
        if (sourceItemsWithDOI.length == 0){
            Services.prompt.alert(
                window,
                Wikicite.getString('wikicite.crossref.get-citations.no-doi-title'),
                Wikicite.getString('wikicite.crossref.get-citations.no-doi-message')
            );
            return;
        }

        // Get reference information for items from CrossRef
        const progress = new Progress(
            'loading',
            Wikicite.getString('wikicite.crossref.get-citations.loading')
        );

        let sourceItemReferences;
        try{
             sourceItemReferences = await Promise.all(
                sourceItemsWithDOI.map(async (sourceItem) => await Crossref.getReferences(sourceItem.doi))
            );
        }
        catch (error){
            progress.updateLine(
                'error',
                Wikicite.getString('wikicite.crossref.get-citations.error-getting-references')
            );
            debug(error);
            return;
        }
        
        // Confirm with the user to add these citations
        const numberOfCitations = sourceItemReferences.map((references) => references.length);
        const itemsToBeUpdated = numberOfCitations.filter((number) => number > 0).length;
        const citationsToBeAdded = numberOfCitations.reduce((sum, value) => sum + value, 0);
        if (numberOfCitations == 0){
            progress.updateLine(
                'error',
                Wikicite.getString('wikicite.crossref.get-citations.no-references')
            );
            return;
        }
        const confirmed = Services.prompt.confirm(
            window,
            Wikicite.getString('wikicite.crossref.get-citations.confirm-title'),
            Wikicite.formatString('wikicite.crossref.get-citations.confirm-message', [itemsToBeUpdated, sourceItems.length, citationsToBeAdded])
        )
        if (!confirmed){
            progress.close();
            return;
        }
            
        // Parse this reference information, then add to sourceItems
        progress.updateLine(
            'loading',
            Wikicite.getString('wikicite.crossref.get-citations.parsing')
        );

        try {
            let parsedItemReferences = [];
            let parsedItems = 0;
            for (let sourceItemReferenceList of sourceItemReferences) {
                if (!sourceItemReferenceList.length) {
                    parsedItemReferences.push([]);
                    continue;
                }

                parsedItemReferences.push(await Crossref.parseReferences(sourceItemReferenceList));
                progress.updateLine(
                    'loading',
                    Wikicite.formatString('wikicite.crossref.get-citations.parsing-progress', [++parsedItems, itemsToBeUpdated])
                );
            }
            
            // Add these citations to the items
            await Zotero.DB.executeTransaction(async function() {
                for (let i = 0; i < sourceItemsWithDOI.length; i++){
                    const sourceItem = sourceItemsWithDOI[i];
                    const newCitedItems = parsedItemReferences[i];
                    if (newCitedItems.length > 0){
                        const newCitations = newCitedItems.map((newItem) => new Citation({item: newItem, ocis: []}, sourceItem));
                        sourceItem.addCitations(newCitations);
                    }
                }
            })
            progress.updateLine(
                'done',
                Wikicite.getString('wikicite.crossref.get-citations.done')
            );
        }
        catch (error){
            progress.updateLine(
                'error',
                Wikicite.getString('wikicite.crossref.get-citations.error-parsing-references')
            );
            debug(error);
        }
        finally {
            progress.close();
        }
    }

    /**
     * Get a list of references from Crossref for an item with a certain DOI.
     * Returned in JSON Crossref format.
     * @param {string} doi - DOI for the item for which to get references.
     * @returns {Promise<string[]>} list of references, or [] if none.
     */
    static async getReferences(doi) {
        const JSONResponse = await Crossref.getCrossrefDOI(doi);
        if (!JSONResponse || !JSONResponse.message.reference) {
            return [];
        }

        return JSONResponse.message.reference;
    }

    /**
     * Parse a list of references in JSON Crossref format.
     * @param {string[]} crossrefReferences - Array of Crossref references to parse to Zotero items.
     * @returns {Promise<Zotero.Item[]>} Zotero items parsed from references (where parsing is possible).
     */
    static async parseReferences(crossrefReferences){
        if (!crossrefReferences.length){
            debug("Item found in Crossref but doesn't contain any references");
            return [];
        }

        const parsedReferences = await Promise.all(
            crossrefReferences.map(async (reference) => await Crossref.parseReferenceItem(reference))
        );
        return parsedReferences.filter(Boolean);
    }

    /**
     * Parse a single item in JSON Crossref format to a Zotero Item.
     * @param {string} crossrefItem - An reference item in JSON Crossref format.
     * @returns {Promise<Zotero.Item | null>} Zotero item parsed from the Crossref reference, or null if parsing failed.
     */
    static async parseReferenceItem(crossrefItem){
        let newItem = null;
        if (crossrefItem.DOI){
            newItem = await this.getItemFromIdentifier({DOI: crossrefItem.DOI});
        }
        else if(crossrefItem.isbn){
            newItem = await this.getItemFromIdentifier({ISBN: crossrefItem.ISBN});
        }
        else{
            newItem = this.parseItemFromCrossrefReference(crossrefItem);
        }
        return newItem;
    }

    /**
     * Get a Zotero Item from a valid Zotero identifier - includes DOI, ISBN, PMID, ArXiv ID, and more.
     * @param {{string: string}} identifier - A reference item in JSON Crossref format.
     * @returns {Promise<Zotero.Item | null>} Zotero item parsed from the identifier, or null if parsing failed.
     */
    static async getItemFromIdentifier(identifier){
        await Zotero.Schema.schemaUpdatePromise;
        let translation = new Zotero.Translate.Search();
        translation.setIdentifier(identifier);

        let jsonItems;
        try {
            // set libraryID to false so we don't save this item in the Zotero library
            jsonItems = await translation.translate({libraryID: false});
        } catch {
            debug('No items returned for identifier ' + identifier);
        }

        if (jsonItems) {
            const jsonItem = jsonItems[0];
            // delete irrelevant fields to avoid warnings in Item#fromJSON
            delete jsonItem['notes'];
            delete jsonItem['seeAlso'];
            delete jsonItem['attachments'];

            const newItem = new Zotero.Item(jsonItem.itemType);
            newItem.fromJSON(jsonItem);
            return newItem;
        }
        else{
            return null;
        }
    }

    /**
     * Get a Zotero Item from a Crossref reference item that doesn't include an identifier.
     * @param {string} crossrefItem - A reference item in JSON Crossref format.
     * @returns {Promise<Zotero.Item | null>} Zotero item parsed from the identifier, or null if parsing failed.
     */
    static parseItemFromCrossrefReference(crossrefItem){
        let jsonItem = {};
        if (crossrefItem['journal-title']){
            jsonItem.itemType = 'journalArticle';
            jsonItem.title = crossrefItem['article-title'] || crossrefItem['volume-title'];
        }
        else if(crossrefItem['volume-title']){
            jsonItem.itemType = 'book';
            jsonItem.title = crossrefItem['volume-title'];
        }
        else if(crossrefItem.unstructured){
            // todo: Implement reference text parsing here
            debug("Couldn't parse Crossref reference - unstructured references are not yet supported. " + JSON.stringify(crossrefItem));
            return null;
        }
        else{
            debug("Couldn't determine type of Crossref reference - doesn't contain `journal-title` or `volume-title` field. " + JSON.stringify(crossrefItem));
            return null;
        }
        jsonItem.date = crossrefItem.year;
        jsonItem.pages = crossrefItem['first-page'];
        jsonItem.volume = crossrefItem.volume;
        jsonItem.issue = crossrefItem.issue;
        jsonItem.creators = [{
            'creatorType': 'author',
            'name': crossrefItem.author
        }];
        // remove undefined properties
        for (let key in jsonItem){
            if(jsonItem[key] === undefined){
                delete jsonItem[key];
            }
        }
        const newItem = new Zotero.Item(jsonItem.itemType);
        newItem.fromJSON(jsonItem);
        return newItem;
    }

    /**
     * Get the information about an item from Crossref via DOI lookup.
     * @param {string} doi - DOI for the item of interest.
     * @returns {Promise<string>} JSON Crossref item. Format described at https://api.crossref.org/swagger-ui/index.html#/Works/get_works__doi_
     */
    static async getCrossrefDOI(doi) {
        let url = `https://api.crossref.org/works/${Zotero.Utilities.cleanDOI(doi)}`;
        let JSONResponse;

        try{
            const response = await Zotero.HTTP.request('GET',
            url,
            {
                headers: { 
                    'User-Agent': `${Wikicite.getUserAgent()} mailto:cita@duck.com` 
                }
            });
            JSONResponse = JSON.parse(response.responseText);
        }
        catch {
            debug("Couldn't access URL: " + url);
        }

        return JSONResponse;
    }
}
