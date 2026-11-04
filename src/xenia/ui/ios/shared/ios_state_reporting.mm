/**
 ******************************************************************************
 * Xenia : Xbox 360 Emulator Research Project                                 *
 ******************************************************************************
 * Copyright 2026 Ben Vanik. All rights reserved.                             *
 * Released under the BSD license - see LICENSE in the root for more details. *
 ******************************************************************************
 */

#import "xenia/ui/ios/shared/ios_state_reporting.h"

#import <Foundation/Foundation.h>
// Optional SDK support: the framework was introduced after the iOS 18 minimum.
#if __has_include(<StateReporting/StateReporting.h>)
#import <StateReporting/StateReporting.h>
#define XE_IOS_STATE_REPORTING_SDK_AVAILABLE 1
#else
#define XE_IOS_STATE_REPORTING_SDK_AVAILABLE 0
#endif

void xe_ios_state_reporting_note_title(uint32_t title_id) {
#if XE_IOS_STATE_REPORTING_SDK_AVAILABLE
  if (@available(iOS 27.0, *)) {
    @autoreleasepool {
      // Rare (a game starting or ending), far below the rate limit.
      SRStateReporter* reporter = [SRStateReporter reporterForDomain:@XE_IOS_STATE_DOMAIN_TITLE];
      if (!title_id) {
        [reporter reportTransitionToStateLabel:nil stableMetadata:nil volatileMetadata:nil];
        return;
      }
      [reporter reportTransitionToStateLabel:@"game"
                              stableMetadata:@{
                                @"titleId" : [NSString stringWithFormat:@"%08X", title_id]
                              }
                            volatileMetadata:nil];
    }
  }
#else
  (void)title_id;
#endif
}
