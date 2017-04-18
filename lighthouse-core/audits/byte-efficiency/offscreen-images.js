/**
 * @license
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
 /**
  * @fileoverview Checks to see if images are displayed only outside of the viewport.
  *     Images requested after TTI are not flagged as violations.
  */
'use strict';

const Audit = require('./byte-efficiency-audit');
const TTIAudit = require('../time-to-interactive');
const URL = require('../../lib/url-shim');

const ALLOWABLE_OFFSCREEN_X = 100;
const ALLOWABLE_OFFSCREEN_Y = 200;

const IGNORE_THRESHOLD_IN_BYTES = 2048;
const IGNORE_THRESHOLD_IN_PERCENT = 75;

class OffscreenImages extends Audit {
  /**
   * @return {!AuditMeta}
   */
  static get meta() {
    return {
      category: 'Images',
      name: 'offscreen-images',
      description: 'Offscreen images',
      informative: true,
      helpText: 'Images that are not above the fold should be lazily loaded after the page is ' +
        'interactive. Consider using the [IntersectionObserver](https://developers.google.com/web/updates/2016/04/intersectionobserver) API.',
      requiredArtifacts: ['ImageUsage', 'ViewportDimensions', 'traces', 'networkRecords']
    };
  }

  /**
   * @param {!ClientRect} imageRect
   * @param {{innerWidth: number, innerHeight: number}} viewportDimensions
   * @return {number}
   */
  static computeVisiblePixels(imageRect, viewportDimensions) {
    const innerWidth = viewportDimensions.innerWidth;
    const innerHeight = viewportDimensions.innerHeight;

    const top = Math.max(imageRect.top, -1 * ALLOWABLE_OFFSCREEN_Y);
    const right = Math.min(imageRect.right, innerWidth + ALLOWABLE_OFFSCREEN_X);
    const bottom = Math.min(imageRect.bottom, innerHeight + ALLOWABLE_OFFSCREEN_Y);
    const left = Math.max(imageRect.left, -1 * ALLOWABLE_OFFSCREEN_X);

    return Math.max(right - left, 0) * Math.max(bottom - top, 0);
  }

  /**
   * @param {!Object} image
   * @param {{innerWidth: number, innerHeight: number}} viewportDimensions
   * @return {?Object}
   */
  static computeWaste(image, viewportDimensions) {
    const url = URL.getDisplayName(image.src, {preserveQuery: true});
    const totalPixels = image.clientWidth * image.clientHeight;
    const visiblePixels = this.computeVisiblePixels(image.clientRect, viewportDimensions);
    // Treat images with 0 area as if they're offscreen. See https://github.com/GoogleChrome/lighthouse/issues/1914
    const wastedRatio = totalPixels === 0 ? 1 : 1 - visiblePixels / totalPixels;
    const totalBytes = image.networkRecord.resourceSize;
    const wastedBytes = Math.round(totalBytes * wastedRatio);

    if (!Number.isFinite(wastedRatio)) {
      return new Error(`Invalid image sizing information ${url}`);
    }

    return {
      url,
      preview: {
        url: image.networkRecord.url,
        mimeType: image.networkRecord.mimeType
      },
      requestStartTime: image.networkRecord.startTime,
      totalBytes,
      wastedBytes,
      wastedPercent: 100 * wastedRatio,
    };
  }

  /**
   * @param {!Artifacts} artifacts
   * @return {{results: !Array<Object>, tableHeadings: Object,
   *     passes: boolean=, debugString: string=}}
   */
  static audit_(artifacts) {
    const images = artifacts.ImageUsage;
    const viewportDimensions = artifacts.ViewportDimensions;

    let debugString;
    const resultsMap = images.reduce((results, image) => {
      if (!image.networkRecord) {
        return results;
      }

      const processed = OffscreenImages.computeWaste(image, viewportDimensions);
      if (processed instanceof Error) {
        debugString = processed.message;
        return results;
      }

      // If an image was used more than once, warn only about its least wasteful usage
      const existing = results.get(processed.preview.url);
      if (!existing || existing.wastedBytes > processed.wastedBytes) {
        results.set(processed.preview.url, processed);
      }

      return results;
    }, new Map());

    return TTIAudit.audit(artifacts).then(ttiResult => {
      const ttiTimestamp = ttiResult.extendedInfo.value.timestamps.timeToInteractive / 1000000;
      const results = Array.from(resultsMap.values()).filter(item => {
        const isWasteful = item.wastedBytes > IGNORE_THRESHOLD_IN_BYTES &&
            item.wastedPercent > IGNORE_THRESHOLD_IN_PERCENT;
        const loadedEarly = item.requestStartTime < ttiTimestamp;
        return isWasteful && loadedEarly;
      });
      return {
        debugString,
        results,
        tableHeadings: {
          preview: '',
          url: 'URL',
          totalKb: 'Original',
          potentialSavings: 'Potential Savings',
        }
      };
    });
  }
}

module.exports = OffscreenImages;