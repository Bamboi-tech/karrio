"use client";

import React from "react";
import { Button } from "@karrio/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@karrio/ui/components/ui/dropdown-menu";
import { ChevronUp } from "lucide-react";
import { cn } from "@karrio/ui/lib/utils";

interface ListPaginationProps {
  currentOffset: number;
  pageSize: number;
  totalCount: number;
  hasNextPage: boolean;
  onPageChange: (offset: number) => void;
  // Optional page-size picker, rendered next to the results count. The
  // pagination footer sits at the bottom of the viewport, so the menu opens
  // UPWARD (side="top") — there is no room below it.
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  className?: string;
}

export const ListPagination: React.FC<ListPaginationProps> = ({
  currentOffset,
  pageSize,
  totalCount,
  hasNextPage,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  className,
}) => {
  const currentPage = Math.floor(currentOffset / pageSize) + 1;
  const startItem = currentOffset + 1;
  const endItem = Math.min(currentOffset + pageSize, totalCount);

  const handlePrevious = () => {
    if (currentOffset > 0) {
      onPageChange(Math.max(0, currentOffset - pageSize));
    }
  };

  const handleNext = () => {
    if (hasNextPage) {
      onPageChange(currentOffset + pageSize);
    }
  };

  return (
    <div
      className={cn("flex items-center justify-between px-2 py-2", className)}
    >
      {/* Results count - left side */}
      <div className="flex items-center gap-3">
        <div className="text-sm font-medium text-gray-700">
          {totalCount > 0 ? (
            <span>
              Viewing {startItem}–{endItem} of {totalCount} results
            </span>
          ) : (
            <span>0 results</span>
          )}
        </div>
        {onPageSizeChange && (pageSizeOptions || []).length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="px-2 text-xs">
                {pageSize} per page
                <ChevronUp className="h-3 w-3 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-32">
              {(pageSizeOptions || []).map((option) => (
                <DropdownMenuItem
                  key={option}
                  className={cn(option === pageSize && "font-semibold")}
                  onClick={() => onPageSizeChange(option)}
                >
                  {option} per page
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* Navigation buttons - right side */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePrevious}
          disabled={currentOffset === 0}
          className="px-3"
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleNext}
          disabled={!hasNextPage}
          className="px-3"
        >
          Next
        </Button>
      </div>
    </div>
  );
};
